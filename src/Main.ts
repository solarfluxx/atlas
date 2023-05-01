import { useEffect, useMemo, useState } from "react";

namespace Global {
	export let atomCounter = 0;
	
	export interface Context {
		type: 'component' | 'action';
		config: Map<IAtom, Set<string | symbol>>;
	}
	
	export const scans: Context[] = [];
}

type Value<T> = Omit<T, keyof IAtom>;
type MakeAtom<T extends object, P extends boolean> = Value<T> & IAtom<T, P>;

export type Atom<T, U = {}> = (T extends object ? ObjectAtom<T> : PrimitiveAtom<T>) & U;
export type ObjectAtom<T extends object> = MakeAtom<T, false>;
export type PrimitiveAtom<T> = MakeAtom<{
	/** Holds the value of the atom. This value can be read from and written to. */
	value: T;
}, true>;

export type DeepAtom<T> = Atom<{ [K in keyof T]: DeepAtomCollapse<T[K]> }>;
export type DeepAtomCollapse<T> = T extends object ? DeepAtom<T> : T;

export type PrimeAtom<T> = Atom<{ [K in keyof T]: PrimeAtomCollapse<T[K]> }>;
export type PrimeAtomCollapse<T> = T extends object ? PrimeAtom<T> : Atom<T>;

export type Unatom<T> = (
	T extends Atom<infer U> ? Unatom<U>
	: T extends object ? { [K in keyof T]: Unatom<T[K]> }
	: T
);

function isObject(value: any): value is object {
	return typeof value === 'object' && value !== null;
}

export type AtomValue<T, P> = P extends true ? (T extends { value: any } ? T['value'] : never) : T;

export class IAtom<T extends object = object, P extends boolean = boolean> {
	static getMethods() {
		return Object.assign(this.atom.bind(this), {
			deep: this.deep.bind(this),
			prime: this.prime.bind(this),
			focus: this.focus.bind(this),
			unatom: this.unatom.bind(this),
		});
	}
	
	static atom<T extends object>(value: T): ObjectAtom<T>;
	static atom<T>(value: T): PrimitiveAtom<T>;
	static atom<T>(value: T) {
		const valueIsObject = isObject(value);
		const source = valueIsObject ? value : { value };
		const atom = new IAtom(source, !valueIsObject);
		return atom.$proxy as Atom<T>;
	}
	
	static deep<T extends object>(value: T) {
		const root: object = Array.isArray(value) ? [ ...value ] : { ...value };
		for (const key in root) {
			const value = root[key as keyof typeof root];
			if (value && typeof value === 'object') {
				root[key as keyof typeof root] = this.deep(value);
			}
		}
		return this.atom(root) as DeepAtomCollapse<T>;
	}
	
	static prime<T extends object>(value: T) {
		const root: object = Array.isArray(value) ? [ ...value ] : { ...value };
		for (const key in root) {
			const value = root[key as keyof typeof root];
			(root[key as keyof typeof root] as any) = (
				(value !== null && typeof value === 'object')
				? this.prime(value)
				: this.atom(value)
			);
		}
		return this.atom(root) as PrimeAtomCollapse<T>;
	}
	
	static focus<T>(reference: () => T) {
		const createFocusAtom = () => {
			const context: Global.Context = { type: 'action', config: new Map() };
			Global.scans.push(context);
			const value = reference();
			if (context.config.size !== 1) { throw new Error(`Atom focus reference expected 1 target value, got ${context.config.size}`); }
			const [ origin, props ] = [ ...context.config ][0];
			if (props.size !== 1) { throw new Error(`Atom focus reference expected 1 target value, got ${context.config.size}`); }
			const prop = [ ...props ][0];
			const local = this.atom(value);
			Global.scans.pop();
			const localObserver = () => {
				(origin.$source as any)[prop] = local.value;
				origin.$notify(prop, originObserver);
			};
			const originObserver = () => {
				local.$source.value = (origin as any)[prop];
				local.$notify('value', localObserver);
			};
			const localCleanup = local.$watch(new Set([ 'value' ]), localObserver);
			const originCleanup = origin.$watch(props, originObserver);
			return [ local, () => {
				localCleanup();
				originCleanup();
			} ] as const;
		};
		
		if (Global.scans.at(-1)?.type === 'component') {
			const [ atom, cleanup ] = useMemo(createFocusAtom, []);
			useEffect(() => cleanup, []);
			return atom;
		}
		
		return createFocusAtom()[0];
	}
	
	static unatom<T>(value: T) {
		if (typeof value !== 'object' || value === null) { return value as Unatom<T>; }
		const current = value instanceof IAtom ? value.$source : value;
		const raw: object = Array.isArray(current) ? [ ...current ] : { ...current };
		for (const key in raw) {
			raw[key as keyof typeof raw] = (
				(typeof value === 'object' || value !== null)
				? this.unatom(raw[key as keyof typeof raw])
				: raw[key as keyof typeof raw]
			);
		}
		return raw as Unatom<T>;
	}
	
	private $proxy!: any;
	private $observers: { [prop: string | symbol]: Set<() => void> } = {};
	
	/**
	 * Holds the unique ID for this atom.
	 * This can be used for the `key` prop in components.
	 * 
	 * **Key Example**
	 * ```tsx
	 * atoms.map(atom =>
	 * 	<div key={atom.$id}>...<div>
	 * );
	 * ```
	 */
	public readonly $id = Global.atomCounter++;
	
	constructor(private $source: T, private $primitive: P) {
		this.$proxy = new Proxy($source, {
			get: (_target, key, receiver: Atom<T>) => {
				if (key in this) {
					const prop = this[key as keyof this];
					return (typeof prop === 'function'
						? new Proxy(prop, {
							apply(target, thisArg, argArray) {
								const outgoing = Reflect.apply(target, thisArg, argArray);
								return outgoing === target ? receiver : outgoing;
							},
						})
						: prop
					);
				}
				
				return this.$use(key);
			},
			set: (target, prop, incoming) => {
				target[prop as keyof typeof target] = incoming;
				if (typeof prop === 'string') { this.$notify(prop); }
				return true;
			},
		})
	}
	
	private $notify(prop: string | symbol, ...exceptions: (() => void)[]) {
		if (!this.$observers[prop]) { return; }
		for (const observer of this.$observers[prop]) {
			if (exceptions.includes(observer)) { continue; }
			observer();
		}
	}
	
	private $use(prop: string | symbol) {
		const context = Global.scans.at(-1);
		if (context) {
			const config = context.config.get(this.$proxy) ?? new Set();
			if (config.size === 0) { context.config.set(this.$proxy, config); }
			config.add(prop);
		}
		
		return Reflect.get(this.$source, prop, this.$proxy);
	}
	
	*[Symbol.iterator]() {
		yield `${this.$primitive ? this.$use('value') : this.$use('toString')}`;
	}
	
	/**
	 * Returns an untracked instance of the current value.
	 * Observers will *not* subscribe to this value.
	 */
	$get(): Unatom<AtomValue<T, P>> {
		return IAtom.unatom(this.$primitive ? (this.$source as any).value : this.$source) as any;
	}
	
	/**
	 * Assigns the atom value to the passed value.
	 * 
	 * **Example**
	 * ```
	 * const planet = atom<Planet>({ name: 'Earth', type: 'terrestrial' });
	 * planet.$set({ name: 'Saturn', type: 'gas' });
	 * ```
	 */
	$set(value: AtomValue<T, P>) {
		if (this.$primitive) {
			(this.$source as { value: any }).value = value;
			this.$notify('value');
			return this;
		}
		
		Object.assign(this.$source, value);
		for (const prop in Object.keys(value)) { this.$notify(prop); }
		return this;
	}
	
	/**
	 * Merges the passed value into the current atom value.
	 * Any keys not specified in the passed value will not be changed.
	 * 
	 * **Example**
	 * ```
	 * const user = atom<User>({ id: 14, nick: null, first: 'Sam', last: 'Roger' });
	 * user.$merge({ nick: 'Sam', first: 'Samuel' }); // Preserves `id` and `last` keys
	 * console.log(user.$get()); // { id: 14, nick: 'Sam', first: 'Samuel', last: 'Roger' }
	 * ```
	 */
	$merge(value: Partial<T>) {
		Object.assign(this.$source, value);
		for (const prop in Object.keys(value)) { this.$notify(prop); }
		return this;
	}
	
	/**
	 * Adds an event listener (observer) to this atom.
	 * @returns A function that unbinds the observer (removes the event listener) when called.
	 */
	$watch(props: Set<string | symbol>, observer: () => void) {
		for (const prop of props) {
			if (!this.$observers[prop]) { this.$observers[prop] = new Set(); }
			this.$observers[prop].add(observer);
		}
		
		return () => {
			for (const prop of props) {
				this.$observers[prop].delete(observer);
			}
		};
	}
	
	$with<U extends object | void = void>(feature: (target: this) => U) {
		const properties = feature(this);
		if (properties) { Object.assign(this, properties); }
		return this as U extends void ? this : Atom<T, U>;
	}
}

export function observe() {
	// Create scan context.
	const context: Global.Context = { type: 'component', config: new Map() };
	Global.scans.push(context);
	
	// Create hook for rerendering component.
	const [ , update ] = useState(0);
	
	useEffect(() => {
		// Cleanup context.
		const index = Global.scans.indexOf(context);
		if (index >= 0) { Global.scans.splice(index, 1); }
		
		// Apply observers.
		const cleanups: (() => void)[] = [];
		for (const [ face, props ] of context.config) {
			// Add unwatch action to cleanup array.
			cleanups.push(face.$watch(props, () => update(v => v + 1)));
		}
		
		return () => {
			// Handle cleanup.
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	});
}

export const atom = IAtom.getMethods();
