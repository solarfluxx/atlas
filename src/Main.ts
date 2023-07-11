import { useEffect, useState } from "react";

/// Types
type Key = string | number | symbol;
type Article = { [key: Key]: any };
type Entry<T extends Article> = { state: Atom<T>, key: keyof T };
type Manual = { [key: Key]: Key[] };
export type Reference<T> = { value: T };

type AwaitingAtomArticle<T extends Article = Article> = T & { [Global.asyncSymbol]: AwaitingAtomCallback<any>[] };
export type AwaitingAtomCallback<T> = (this: T, target: T) => void;

/// Helpers
function isIterable(value: any): value is object & Iterable<any> {
	return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

function isArticle(value: any): value is Article {
	return typeof value === 'object' && value !== null && !value[Global.symbol];
}

function isAwaitingAtom(value: any): value is AwaitingAtomArticle {
	return typeof value === 'object' && value !== null && value[Global.asyncSymbol];
}

function atomize<T>(value: T): T {
	if (isAtom(value)) {
		return value;
	}
	
	if (isArticle(value)) {
		return atom(value);
	}
	
	return value;
}

/// Global
module Global {
	export const symbol = Symbol('atom');
	export const asyncSymbol = Symbol('await atom');
	
	export interface Context {
		states: Map<Atom<any>, Set<Key>>;
	}
	
	export interface CallContext {
		states: Function[];
	}
	
	export let count = 0;
	
	export const contexts: Context[] = [];
	export const callContexts: CallContext[] = [];
	
	export const memoized = new Map<Article, Atom<any>>();
	
	export const manuals = new Map<object, Manual>([
		[WeakSet, {}],
		[WeakMap, {}],
		[Set, {
			add: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
			delete: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
			clear: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
		}],
		[Map, {
			set: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
			delete: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
			clear: [ 'size', 'has', 'keys', 'values', 'entries', 'forEach', Symbol.iterator ],
		}],
	]);
}

/// Class
class Atom<T extends Article> {
	/** Stores the observers attached to this atom. */
	public observers = new Map<keyof T, Set<(key: keyof T) => void>>();
	
	/** Stores the references of each key. */
	public references = new Map<keyof T, Reference<any>>;
	
	/** Stores the cached method proxies. */
	public methodCache: { [key: string | symbol]: Function } = {};
	
	public constructor(public target: T, public wrapper: T, public manual?: Manual) {}
	
	/**
	 * Returns an unatomized copy of the source.
	 */
	public distill(seen = new Map<object, object>()) {
		const distilled = { ...this.target };
		seen.set(this, distilled);
		
		for (const key in distilled) {
			if (isAtom(distilled[key])) {
				const state = getAtom(distilled[key])!;
				(distilled[key] as any) = seen.get(state) ?? state.distill(seen);
			}
		}
		
		return distilled;
	}
	
	/**
	 * Returns the value stored at the provided key.
	 */
	public get(key: keyof T) {
		const self = this.manual ? this.target : this.wrapper;
		const value = Reflect.get(this.target, key, self);
		if (typeof value !== 'function') { return value; }
		return this.methodCache[key] ?? (this.methodCache[key] = new Proxy(value, {
			apply: (method, _proxy, parameters) => {
				// Create call context.
				const callContext: Global.CallContext = { states: [] };
				Global.callContexts.push(callContext);
				
				// Call target.
				const result = Reflect.apply(method, self, parameters.map(parameter => atomize(parameter)));
				
				// Cleanup call context.
				const index = Global.callContexts.indexOf(callContext);
				if (index >= 0) { Global.callContexts.splice(index, 1); }
				
				if (this.manual && this.manual[key]) {
					this.notify(this.manual[key]);
				}
				
				return result;
			},
		}));
	}
	
	/**
	 * Registers the provided key in the current context.
	 * The context determines what happens to the registered entries.
	 * 
	 * Usually, the context will subscribe to each entry, triggering an update when an entry receives a notification.
	 */
	public subscribe(key: keyof T) {
		// Get context.
		const context = Global.contexts.at(-1);
		
		if (context) {
			const keys = context.states.get(this) ?? new Set();
			if (keys.size === 0) { context.states.set(this, keys); }
			
			// Add key to context.
			keys.add(key);
		}
	}
	
	/**
	 * Sends a notification to all observers of the provided key, excluding the exceptions.
	 */
	public notify(key: keyof T | Iterable<keyof T>, ...exceptions: ((key: keyof T) => void)[]) {
		const keys = isIterable(key) ? key : [ key ];
		
		// Notify observers.
		for (const key of keys) {
			const observers = this.observers.get(key);
			if (!observers) { continue; }
			for (const observer of observers) {
				!exceptions.includes(observer) && observer(key);
			}
		}
	}
	
	/**
	 * Attaches an observer to the provided key.
	 * When the provided key receives a notification, the provided observer will be called.
	 */
	public watch(key: keyof T | Iterable<keyof T>, observer: (key: keyof T) => void) {
		const keys = isIterable(key) ? key : [ key ];
		
		// Attach observers.
		for (const key of keys) {
			const observers = this.observers.get(key) ?? new Set();
			if (observers.size === 0) { this.observers.set(key, observers); }
			observers.add(observer);
		}
		
		return () => {
			// Remove observers.
			for (const key of keys) {
				this.observers.get(key)?.delete(observer);
			}
		};
	}
	
	/**
	 * Links a key on this to a peer entry.
	 * If the value on one side changes, the other will be updated to match.
	 */
	public link<P extends Entry<any>>(key: keyof T, peer: P) {
		const primary = () => {
			Reflect.set(peer.state.target, peer.key, Reflect.get(this.target, key, this.wrapper));
			peer.state.notify(peer.key, secondary);
		};
		
		const secondary = () => {
			Reflect.set(this.target, key, Reflect.get(peer.state.target, peer.key, this.wrapper));
			this.notify(key, primary);
		};
		
		const unwatchPrimary = this.watch(key, primary);
		const unwatchSecondary = peer.state.watch(peer.key, secondary);
		
		return () => {
			unwatchPrimary();
			unwatchSecondary();
		};
	}
	
	/**
	 * Returns a reference to the provided key.
	 */
	public focus<K extends keyof T>(key: K): Reference<T[K]> {
		let reference = this.references.get(key);
		
		if (!reference) {
			reference = atom({ value: Reflect.get(this.target, key, this.wrapper) });
			getAtom(reference).link('value', { state: this, key });
			this.references.set(key, reference);
		}
		
		return reference;
	}
}

/// Functions

/**
 * Returns an atom of the given source value.
 * If the value is primitive, it will be wrapped in an object.
 * 
 * **Note**:
 * Atoms mutate their sources. If this behaviour is unwanted, pass in a clone of the original value.
 */
export function atom<T extends Function>(source: T): Reference<T>;
export function atom<T extends Article>(source: T): T;
export function atom<T>(source: T): Reference<T>;
export function atom<T extends Article>(source: T): T {
	if (!isArticle(source)) {
		// Coerce source to object.
		source = { value: source } as any;
	}
	
	// Handle memoization.
	const computed = Global.memoized.get(source);
	if (computed) { return computed.wrapper; }
	
	// Create proxy.
	const wrapper: T = new Proxy(source, {
		get(_target, key, _proxy) {
			if (key === Global.symbol) { return state; }
			state.subscribe(key);
			return state.get(key);
		},
		set(target, key, incoming, proxy) {
			Reflect.set(target, key, atomize(incoming), proxy);
			state.notify(key);
			return true;
		},
	});
	
	// Create state and memoize.
	const state = new Atom(source, wrapper, Global.manuals.get(source.constructor));
	Global.memoized.set(source, state);
	
	// Recursively atomize properties.
	for (const key in source) {
		source[key] = atomize(source[key]);
	}
	
	// Resolve awaiting callback.
	if (isAwaitingAtom(source)) {
		for (const callback of source[Global.asyncSymbol]) { callback.call(wrapper, wrapper); }
		delete (source as Article)[Global.asyncSymbol];
	}
	
	return wrapper;
}

/**
 * Creates a reference to an atom property.
 * 
 * The source and reference are linked together; updating one will update the other.
 * 
 * **Example**
 * ```
 * const state = atom({ counter: 0 });
 * const counter = focusAtom(() => state.counter);
 * 
 * state.counter += 5; // Updates `counter.value`
 * counter.value += 10; // Updates `state.counter`
 * 
 * console.log(state); // { counter: 15 }
 * console.log(counter); // { value: 15 }
 * ```
 */
export function focusAtom<T>(observer: () => T): Reference<T> {
	// Create scan context.
	const scan: Global.Context = { states: new Map() };
	Global.contexts.push(scan);
	
	// Do scan.
	const value = observer();
	
	// Cleanup context.
	const index = Global.contexts.indexOf(scan);
	if (index >= 0) { Global.contexts.splice(index, 1); }
	
	let entry: Entry<any> | null = null;
	
	// Find entry point.
	entryScan:
	for (const [ state, keys ] of scan.states) {
		for (const key of keys) {
			if (state.target[key] === value) {
				entry = { state, key };
				break entryScan;
			}
		}
	}
	
	if (!entry) {
		throw new Error('No atom entry found. Make sure an atom property is accessed and returned inside the observer.');
	}
	
	return entry.state.focus(entry.key);
};

/**
 * Removes all atoms from a copy of `value` and returns it.
 */
export function distillAtom<T>(value: T) {
	if (isAtom(value)) {
		const state = getAtom(value)!;
		return state.distill();
	}
	
	return value;
}

/**
 * Executes the callback when the target is atomized.
 */
export function whenAtom<T extends Article>(target: T, callback: AwaitingAtomCallback<T>) {
	if (isAwaitingAtom(target)) {
		target[Global.asyncSymbol]?.push(callback);
		return;
	}
	
	(target as AwaitingAtomArticle<T>)[Global.asyncSymbol] = [ callback ];
}

/**
 * Returns the atom state instance for an object.
 */
export function getAtom<T extends Article>(value: T): Atom<T> {
	const state: Atom<T> | null = typeof value === 'object' && value !== null ? (value as any)[Global.symbol] : null;
	if (!state) { throw new Error(`Cannot get atom state for the given value. ${typeof value === 'object' ? 'Expected atomized object but got object.' : `Expected object but got ${typeof value}`}`); }
	return state;
}

/**
 * Check if value is an atomized object.
 */
export function isAtom(value: any): value is { [Global.symbol]: Atom<any> } {
	return typeof value === 'object' && value !== null && !!value[Global.symbol];
}

/**
 * Registers this component as an atom observer.
 * Atom properties that are read after this is called will trigger the component to rerender when they change.
 * 
 * This *must* be called before accessing any atom properties.
 * Odd behaviour can emerge if this is not respected.
 */
export function observe(): void;
export function observe(observer: () => void): () => void;
export function observe(observer?: () => void): void | (() => void) {
	if (observer) {
		// Create scan context.
		const scan: Global.Context = { states: new Map() };
		Global.contexts.push(scan);
		
		// Do scan.
		observer();
		
		// Cleanup context.
		const index = Global.contexts.indexOf(scan);
		if (index >= 0) { Global.contexts.splice(index, 1); }
		
		if (scan.states.size === 0) {
			console.warn("Observer uses no atoms. Check that the observer reads an atom's property and the observer is not called from a class constructor.");
		}
		
		// Apply observers.
		const observers: (() => void)[] = [];
		for (const [ state, keys ] of scan.states) {
			// Add unwatch action to array.
			observers.push(state.watch(keys, observer));
		}
		
		return () => {
			// Handle cleanup.
			for (const cleanup of observers) { cleanup(); }
		};
	}
	
	// Create scan context.
	const scan: Global.Context = { states: new Map() };
	Global.contexts.push(scan);
	
	// Create hook for rerendering.
	const [ , update ] = useState(0);
	
	useEffect(() => {
		// Cleanup context.
		const index = Global.contexts.indexOf(scan);
		if (index >= 0) { Global.contexts.splice(index, 1); }
		
		// Apply observers.
		const observers: (() => void)[] = [];
		for (const [ state, keys ] of scan.states) {
			// Add unwatch action to array.
			observers.push(state.watch(keys, () => update(v => v + 1)));
		}
		
		return () => {
			// Handle cleanup.
			for (const cleanup of observers) { cleanup(); }
		};
	});
}

export function unobserve(): void;
export function unobserve<T>(observer: () => T): T;
export function unobserve<T>(observer?: () => T): void | T {
	if (observer) {
		// Create capturing scan context.
		const scan: Global.Context = { states: new Map() };
		Global.contexts.push(scan);
		
		// Capture scan.
		const result = observer();
		
		// Delete context.
		const index = Global.contexts.indexOf(scan);
		if (index >= 0) { Global.contexts.splice(index, 1); }
		
		return result;
	}
	
	// Create capturing scan context.
	const scan: Global.Context = { states: new Map() };
	Global.contexts.push(scan);
	
	useEffect(() => {
		// Delete context.
		const index = Global.contexts.indexOf(scan);
		if (index >= 0) { Global.contexts.splice(index, 1); }
	});
}
