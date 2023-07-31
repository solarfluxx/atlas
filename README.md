# Description

Atlas is an object-optimized state management library for React functional components.

# Installation

```shell
# with yarn:
yarn add @solarfluxx/atlas

# with npm:
npm i @solarfluxx/atlas
```

# Guide

The basic premise revolves around "atoms" and "observers". Atoms are a stateful slice of data and observers subscribe to those atoms—updating when state changes.

Take a look the following example of a simple counter app:
```tsx
import { atom, observe } from '@solarfluxx/atlas';

const count = atom(0); // Creates an atom with the initial value `0`.

function App() {
    observe(); // Subscribes this component to watch for updates.
    
    return (
        <div>
            <div>Count: { count.value }</div>
            
            <button onClick={() => count.value++}>Increment</button>
        </div>
    );
}
```

In this example, the `atom` function returns an object that looks something like `{ value: number }` (more information on why primitives are wrapped below). Inside the `App` component, a call to `observe` is made. This call will subscribe the `App` component, causing it to rerender when any of the atoms accessed inside of it are updated.

> **Note**  
> To prevent unexpected behavior, `observe` must be called in every component that accesses an atom **and** it must be called *before* any atoms are accessed.

---

Let's look at a more complex example:
```jsx
import { atom, observe } from '@solarfluxx/atlas';

const users = atom([
    { name: 'John', email: 'john@example.com' },
    { name: 'Ryan', email: 'ryan@example.com' },
]);

function App() {
    observe();
    
    return (
        <div>
            { users.map(user => <User user={user} />) }
        </div>
    );
}

function User({ user }) {
    observe();
    
    return (
        <div>
            <input value={user.name} onChange={(event) => (user.name = event.currentTarget.value)} />
            <input value={user.email} onChange={(event) => (user.email = event.currentTarget.value)} />
        </div>
    );
}
```
In this example, `App` will rerender when the `users` array changes but **not** when a user's name or email changes. This is because the `App` component does not read `name` or `email`. However, the `User` component does and will rerender in those cases. Why? Because even though `{ name: 'John', email: 'john@example.com' }` is not directly wrapped with `atom()`, objects are atomized recursively, so all of the array elements are atomized as well.

## Understanding `atom`

So far I've been talking about atoms as if they were a unique object, and they *are* under the hood, but *practically* they mimic the original data structure. Take a look at the following examples:

```ts
const user = atom({ name: 'Sam', email: 'sam@example.com' });

// Accessing properties is as expected.
console.log(user.name, user.email); // 'Sam sam@example.com'
```

```ts
const planets = atom([ { name: 'Earth', type: 'Gas' }, { name: 'Saturn', type: 'Gas' } ]);

// Indexing is as expected.
planets[0].type = 'Terrestrial'; // Change Earth's type to Terrestrial.

// Methods also work.
console.log(planets.map(planet => planet.name).join(', ')); // 'Earth, Saturn'
```

The only exception to the mimic rule is when **directly atomizing primitives**. Take a look:

```ts
const count = atom(5);

// The value is accessed via `.value` instead of directly.
count.value += 10;

console.log(count.value); // 15
```

However, when a primitive is inside of an object this does not happen:

```ts
const counter = atom({ count: 10 });

counter.count += 10; // No use of `.value` here.

console.log(counter.count); // 20
```

In effect, `atom(PRIMITIVE)` is changed to `atom({ value: PRIMITIVE })`. The reason for this is because the underlying technology Atlas uses ([proxies](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy)) only work on objects. This requires primitives to be wrapped in an object to work correctly.

## Understanding `observe`

`observe` has two overloads:
```ts
observe(): void;
observe(observer: () => void): () => void;
```

When called without a parameter, it will subscribe a React component using React hooks:

```tsx
function App() {
    observe();
    // ...
}
```

However, when called with an observer it will subscribe that observer (like an event listener) to the atoms accessed inside of it. This alternative can be used to listen to atom's outside of a React component:

```ts
const count = atom(0);

// Print the value of `count` when it changes:
observe(() => {
    console.log(count.value);
});
```

Additionally, when passed an observer it will return an unsubscribe function:
```ts
const count = atom(0);

// Print the value of `count` when it changes:
const unsubscribe = observe(() => {
    console.log(count.value);
});

// ...

unsubscribe();
```

## Understanding `unobserve`

`observe` has a sister method: `unobserve`. As the name suggests, it does the opposite of `observe`. When called without a parameter, it will unsubscribe the current React component:

```tsx
function MyComponent() {
    unobserve(); // Stops this component from subscribing to atoms.
    
    // Safe to access atom's without triggering rerenders.
    // ...
}
```

Like `observe`, `unobserve` can accept a callback function. Unlike `observe` however, this callback will not subscribe to the atom's accessed inside of it.

```ts
unobserve(() => {
    // Safe to access atom's without triggering observer updates.
});
```

This callback function can return a value too:

```ts
const count = atom(0);

// ...

const countSnapshot = unobserve(() => count.value);
```

---

The `observe` and `unobserve` functions work together to create and exit reactive scopes. Here's a very strange but valid example of `observe` and `unobserve` usage:

```ts
observe(() => {
    // Accessing atoms here will subscribe to them.
    
    unobserve(() => {
        // Accessing atoms here does nothing special.
        
        observe(() => {
            // Once again, accessing atoms here will subscribe to them.
        });
    });
});
```

Please note that I am *not* suggesting you use them this way. This can create behavior that is hard to read and predict. This example is simply to show you how `observe` and `unobserve` relate to each other.

Here is example that highlights why you need to be cautious when using these two:

```ts
const count = atom(0);
const count2 = atom(0);

observe(() => {
    // This code will run when `count` changes.
    
    console.log('count', count.value);
    
    unobserve(() => {
        // Therefore, code here will run too since `unobserve` immediately invokes its callback.
        
        // The result of this means that the following code will
        // run when `count` changes but will NOT when `count2` changes.
        
        console.log('count2', count2.value);
    });
});
```

As you can see, the logic here feels quite strange. On the contrary though, I'd like you to look at this example; it has the same context structure but is more sensible:

```tsx
const count = atom(0);
const count2 = atom(0);

// This component will rerender when `count` changes but not when `count2` does.
function App() {
    observe();
    
    const count2Snapshot = unobserve(() => count2.value);
    
    return (
        <div>
            { count.value }
            { count2Snapshot }
        </div>
    );
}
```

In this example, `count2` is read without subscribing `App` to it. This has essentially the same logic has the previous example (other than `unobserve` returning a value) but feels more readable, to me anyway. The takeaway point here is: use `unobserve` responsibly.

## Understanding `isAtom`

What if you want to check if an object is an atom? Since the atom mimics the original object, `==`, `===`, `instanceof` or other comparison operators won't work. This is where `isAtom` comes into play.

```ts
const count1 = 0;
const count2 = atom(0);

console.log(isAtom(count1)); // false
console.log(isAtom(count2)); // true
```

## Understanding `distillAtom`

The `distillAtom` function will recursively extract a pure, unatomized, value from an atom.

```ts
const user = atom({
    id: 14,
    name: 'Ted',
    friends: [
        { id: 19, name: 'Jeremy' },
        { id: 8, name: 'Sam' }
    ]
});

console.log(user); // Proxy(Object) { id: 14, name: 'Ted', friends: Proxy(Array) { 0: Proxy(Object) { id: 19, name: 'Jeremy' }, ... } }

const distilledUser = distillAtom(user);

console.log(distilledUser); // { id: 14, name: 'Ted', friends: [ { id: 19, name: 'Jeremy' }, ... ] }
```

## Understanding `focusAtom`

The `focusAtom` function creates a reference to an atom property. The source and reference are linked together; updating one will update the other:

```ts
const state = atom({ count: 0 });
const count = focusAtom(() => state.count);

state.count += 5; // Updates `count.value`.
count.value += 8; // Updates `state.count`.

console.log(state); // { count: 13 }
console.log(count); // { value: 13 }
```

## Understanding `whenAtom`

The `whenAtom` function invokes a callback when the target object is atomized for the first time. This gives you the means to write code that wait until and execute after an object is atomized. This was primarily made for class constructors which execute before atomization. This prevented the constructor from setting up observers.

```ts
class User {
    public fullName!: string;
    
    constructor(public firstName: string, public lastName: string) {
        whenAtom(this, function() {
            observe(() => {
                this.fullName = `${this.firstName} ${this.lastName}`;
            });
        });
    }
}

const user = atom(new User('John', 'Smith')); // Instantiate User and atomize it.
console.log(user.fullName); // 'John Smith'

user.firstName = 'Jack';
console.log(user.fullName); // 'Jack Smith'
```
