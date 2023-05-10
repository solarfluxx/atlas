import { useEffect, useState } from "react";

/// Helpers
function isObject(value: any): value is object {
	return typeof value === 'object' && value !== null;
}

type Predicate<T, R = T> = (current: T) => R;
function isPredicate(value: any): value is Predicate<any> {
	return typeof value === 'function';
}

function extractMethodsOf<T, P extends keyof T, M extends { [K in Exclude<keyof T, P>]?: true }>(target: T, primary: P, methods: M) {
	const sides = {} as { [K in keyof M as K extends keyof T ? (T[K] extends Function ? K : never) : never]: K extends keyof T ? T[K] : never };
	for (const key in methods) { (sides as any)[key] = (target as any)[key].bind(target); }
	return Object.assign((target[primary] as Function).bind(target), sides) as any as T[P] & typeof sides;
}

/// Global
namespace Global {
	export let atomCounter = 0;
	
	export interface Context {
		type: 'component' | 'action';
		config: Map<BaseAtom, Set<string | symbol>>;
	}
	
	export const scans: Context[] = [];
}

/// Types
type Pick<T> = T extends object ? ObjectAtom<T> : PrimitiveAtom<T>;
export type Atom<T> = {} & Pick<T>;
export type ObjectAtom<T extends object = object> = {} & _ObjectAtom<T>['$proxy'];
export type PrimitiveAtom<T = any> = {} & _PrimitiveAtom<T>['$proxy'];

export type DeepAtom<T> = Atom<{ [K in keyof T]: DeepAtomCollapse<T[K]> }>;
export type DeepAtomCollapse<T> = T extends object ? DeepAtom<T> : T;

export type PrimeAtom<T> = Atom<{ [K in keyof T]: PrimeAtomCollapse<T[K]> }>;
export type PrimeAtomCollapse<T> = T extends object ? PrimeAtom<T> : Atom<T>;

export type Unatom<T> = (
	T extends Atom<infer U> ? Unatom<U>
	: T extends object ? { [K in keyof T]: Unatom<T[K]> }
	: T
);

export type Focusable<T> = { [K in keyof T as T[K] extends object ? never : K]: Atom<T[K]> };

/// Classes
abstract class BaseAtom<T extends object = object> {
	/** Returns an atom from the given object. */
	static atom<T extends object>(object: T): Atom<T>;
	/** Returns a primitive atom from the given value. */
	static atom<T>(primitive: T): Atom<T>;
	static atom<T>(value: T): any {
		return isObject(value) ? new _ObjectAtom(value).$proxy : new _PrimitiveAtom({ value }).$proxy;
	}
	
	/** Returns a deeply atomized copy of the given object. */
	static deep<T extends object>(object: T) {
		const copy: object = Array.isArray(object) ? [ ...object ] : { ...object };
		for (const key in copy) {
			const value = copy[key as keyof typeof copy];
			if (value && typeof value === 'object') {
				copy[key as keyof typeof copy] = this.deep(value);
			}
		}
		return this.atom(copy) as DeepAtomCollapse<T>;
	}
	
	/** Removes any atoms in the given value. */
	static unatom<T>(value: T) {
		if (typeof value !== 'object' || value === null) { return value as Unatom<T>; }
		const source = this.sourceOf(value);
		const copy: object = Array.isArray(source) ? [ ...source ] : { ...source };
		for (const key in copy) {
			copy[key as keyof typeof copy] = (
				(typeof value === 'object' || value !== null)
				? this.unatom(copy[key as keyof typeof copy])
				: copy[key as keyof typeof copy]
			);
		}
		return copy as Unatom<T>;
	}
	
	static sourceOf<T>(value: T) {
		return (value instanceof BaseAtom ? value.$source : value) as (T extends BaseAtom<infer Y> ? Y : T);
	}
	
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
	public $focus: Focusable<T>;
	
	protected $proxy: T & this;
	protected $observers: { [prop: string | symbol]: Set<() => void> } = {};
	
	constructor(protected $source: T) {
		this.$proxy = new Proxy($source, {
			get: (_target, key, receiver) => {
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
		}) as (T & this);
		
		const focusedCache: { [K in keyof T]?: any } = {};
		this.$focus = new Proxy($source, {
			get: (_target, key) => {
				if (!(key in focusedCache)) {
					if (!(key in this.$source)) {
						throw new Error(`Cannot focus on invalid key. '${String(key)}' does not exist on atom value.`);
					}
					
					if (typeof this.$source[key as keyof T] === 'object' && this.$source[key as keyof T] !== null) {
						throw new Error(`Atom focus is only allowed for primitives. Tried focusing on '${String(key)}' which points to an object.`);
					}
					
					const local = atom(this.$source[key as keyof T]) as any as PrimitiveAtom<T[keyof T]>;
					
					const observeLocal = () => {
						this.$source[key as keyof T] = local.value;
						this.$notify(key, observeOrigin);
					};
					
					const observeOrigin = () => {
						local.$source.value = this.$source[key as keyof T];
						local.$notify('value', observeLocal);
					};
					
					local.$watch([ 'value' ], observeLocal);
					this.$watch([ key as keyof T ], observeOrigin);
					
					focusedCache[key as keyof T] = local;
				}
				
				return focusedCache[key as keyof T];
			}
		}) as Focusable<T>;
	}
	
	// abstract $get(...parameters: any[]): unknown;
	// abstract $set(...parameters: any[]): this;
	
	protected $notify(key: string | symbol, ...exceptions: Function[]) {
		if (!this.$observers[key]) { return; }
		for (const observer of this.$observers[key]) {
			if (exceptions.includes(observer)) { continue; }
			observer();
		}
	}
	
	protected $use(key: string | symbol) {
		const context = Global.scans.at(-1);
		if (context) {
			const config = context.config.get(this.$proxy) ?? new Set();
			if (config.size === 0) { context.config.set(this.$proxy, config); }
			config.add(key);
		}
		
		return Reflect.get(this.$source, key, this.$proxy);
	}
	
	/**
	 * Adds an event listener (observer) to this atom.
	 * @returns A function that unbinds the observer (removes the event listener) when called.
	 */
	public $watch(props: Iterable<keyof T>, observer: () => void) {
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
	
	/**
	 * Applies a feature to this atom.
	 * Features can attach effects and other custom functionality to the atom.
	 * 
	 * **Note**: This mutates the atom.
	 */
	public $with<U extends object | void = void>(feature: (target: this) => U) {
		const properties = feature(this);
		if (properties) { Object.assign(this, properties); }
		return this as U extends void ? this : (this & U);
	}
}

class _ObjectAtom<T extends object = object> extends BaseAtom<T> {
	/**
	 * Returns an atom-free copy of the current value.
	 * Observers will *not* subscribe to this value.
	 */
	public $get() { return BaseAtom.unatom(this.$source); }
	
	/**
	 * Assigns the atom to the given value.
	 * This method supports deep merging.
	 * 
	 * **Example**
	 * ```
	 * const planet = atom<Planet>({ name: 'Earth', type: 'terrestrial' });
	 * planet.$set({ name: 'Saturn', type: 'gas' });
	 * ```
	 */
	public $set(value: T): this;
	public $set(value: Partial<T>, type: 'merge'): this;
	public $set(value: T | Partial<T>, _type?: 'merge') {
		type SourceKey = keyof typeof source;
		const source = BaseAtom.sourceOf(value);
		
		for (const key in source) {
			const current = this.$source[key as any as keyof T];
			(current instanceof BaseAtom)
				? (current as any).$set(source[key as SourceKey])
				: this.$source[key as any as keyof T] = source[key as SourceKey] as any;
			this.$notify(key);
		}
		
		return this;
	}
	
	public *[Symbol.iterator]() {
		for (const key in this.$source) { yield this.$use(key); }
	}
}

class _PrimitiveAtom<T = any> extends BaseAtom<{ value: T }> {
	/**
	 * Returns the current value.
	 * Observers will *not* subscribe to this value.
	 */
	public $get() { return BaseAtom.unatom(this.$source.value); }
	
	/**
	 * Assigns the atom to the given value.
	 * 
	 * **Example**
	 * ```
	 * const count = atom(0);
	 * //...
	 * count.$set(v => v + 1);
	 * ```
	 */
	public $set(value: T | Predicate<T>) {
		this.$source.value = isPredicate(value) ? value(this.$source.value) : value;
		this.$notify('value');
		return this;
	}
}

/// Functions
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
			cleanups.push(face.$watch(props as any, () => update(v => v + 1)));
		}
		
		return () => {
			// Handle cleanup.
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	});
}

export const atom = extractMethodsOf(BaseAtom, 'atom', { deep: true });
export const unatom = BaseAtom.unatom.bind(BaseAtom);
