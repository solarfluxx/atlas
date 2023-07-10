import { useEffect, useState } from "react";

/// Types
type Key = string | number | symbol;
type Article = { [key: Key]: any };
type Entry<T extends Article> = { state: Atom<T>, key: keyof T };
export type Reference<T> = { value: T };

/// Helpers
function isIterable(value: any): value is object & Iterable<any> {
	return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

function isArticle(value: any): value is Article {
	return typeof value === 'object' && value !== null && !value[Global.symbol];
}

function atomize<T>(value: T): T {
	if (isAtom(value)) {
		return value;
	}
	
	if (typeof value === 'function') {
		return new Proxy(value, {
			apply(target, self, parameters) {
				// Create call context.
				const callContext: Global.CallContext = { states: [] };
				Global.callContexts.push(callContext);
				
				// Call target.
				const result = Reflect.apply(target, self, parameters.map(parameter => atomize(parameter)));
				
				// Cleanup call context.
				const index = Global.callContexts.indexOf(callContext);
				if (index >= 0) { Global.callContexts.splice(index, 1); }
				
				return result;
			},
		});
	}
	
	if (isArticle(value)) {
		return atom(value);
	}
	
	return value;
}

/// Global
module Global {
	export const symbol = Symbol('atom');
	
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
}

/// Class
class Atom<T extends Article> {
	/** Stores the observers attached to this atom. */
	public observers = new Map<keyof T, Set<(key: keyof T) => void>>();
	
	/** Stores the references of each key. */
	public references = new Map<keyof T, Reference<any>>;
	
	constructor(public target: T, public wrapper: T) {}
	
	/**
	 * Returns an unatomized copy of the source.
	 */
	public getRaw() {
		const raw = { ...this.target };
		
		for (const key in raw) {
			if (isAtom(raw[key])) {
				const state = getAtom(raw[key])!;
				(raw[key] as any) = state.getRaw();
			}
		}
		
		return raw;
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
			getAtom(reference)?.link('value', { state: this, key });
			this.references.set(key, reference);
		}
		
		return reference;
	}
}

/// Functions

/**
 * Returns the atom state instance for an object.
 */
export function getAtom<T extends Article>(value: T): Atom<T> {
	const state: Atom<T> | null = typeof value === 'object' && value !== null ? (value as any)[Global.symbol] : null;
	if (!state) { throw new Error(`Cannot get atom state for the given value. ${typeof value === 'object' ? 'Expected atomized object but got object.' : `Expected object but got ${typeof value}`}`); }
	return state;
}

/**
 * Type guard to test if value is an atomized object.
 */
export function isAtom(value: any): value is { [Global.symbol]: Atom<any> } {
	return typeof value === 'object' && value !== null && !!value[Global.symbol];
}

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
		get(target, key, proxy) {
			if (key === Global.symbol) { return state; }
			state.subscribe(key);
			return Reflect.get(target, key, proxy);
		},
		set(target, key, incoming, proxy) {
			Reflect.set(target, key, atomize(incoming), proxy);
			state.notify(key);
			return true;
		},
	});
	
	// Create state and memoize.
	const state = new Atom(source, wrapper);
	Global.memoized.set(source, state);
	
	// Recursively atomize properties.
	for (const key in source) {
		source[key] = atomize(source[key]);
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
 * const counter = atom.focus(() => state.counter);
 * 
 * state.counter += 5; // Will update `counter.value`
 * counter.value += 10; // Will update `state.counter`
 * 
 * console.log(state); // { counter: 15 }
 * console.log(counter); // { value: 15 }
 * ```
 */
atom.focus = function<T>(observer: () => T): Reference<T> {
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
atom.raw = function<T>(value: T) {
	if (isAtom(value)) {
		const state = getAtom(value)!;
		return state.getRaw();
	}
	
	return value;
};

/**
 * Registers this component as an atom observer.
 * Atom properties that are read after this is called will trigger the component to rerender when they change.
 * 
 * This *must* be called before accessing any atom properties.
 * Odd behaviour can emerge if this is not respected.
 */
export function observe(): void;
export function observe(observer?: () => void): () => void;
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
