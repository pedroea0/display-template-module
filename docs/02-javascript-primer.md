# 02 — A JavaScript primer for Java / Python folks

If you read [simpletagdisplay.js](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js) cold, several constructs will look strange. This page covers just enough JavaScript to read the frontend confidently. It's written for someone who is comfortable with OO concepts from Java, Python, or C# but hasn't spent serious time in JS.

If you already know JS, skip to [04-frontend-javascript.md](04-frontend-javascript.md).

## 1. Variables: `let` vs `const`

```js
let count = 0;       // can be reassigned
const PALETTE = [];  // cannot be reassigned (but the array itself is still mutable)
```

You will also occasionally see `var` — older form, function-scoped instead of block-scoped. We avoid it; if you see it in legacy code, treat it as a quirkier `let`.

## 2. Functions

Three syntaxes, all common in the codebase:

```js
// Classic function declaration
function add(a, b) { return a + b; }

// Anonymous function assigned to a variable
const add = function (a, b) { return a + b; };

// Arrow function — shorter form. Also: arrow functions inherit `this`
// from their surrounding scope, which matters inside classes.
const add = (a, b) => a + b;
const square = x => x * x;

// Multi-statement arrow: braces require an explicit return
const greet = name => {
    const msg = 'hello ' + name;
    return msg;
};
```

## 3. Classes

JS got class syntax in 2015. It looks like Java but works very differently under the hood (prototypes, not classical inheritance). For reading code, you can mostly think of it like Java:

```js
class Animal {
    constructor(name) {
        this.name = name;
    }

    speak() {
        return this.name + ' makes a sound.';
    }
}

class Dog extends Animal {
    speak() {
        return this.name + ' barks.';
    }
}

const d = new Dog('Rex');
d.speak(); // "Rex barks."
```

### Class fields and arrow methods

You will see this pattern a lot in our code:

```js
class SimpleTagDisplay {
    constructor() {
        this.count = 0;
    }

    // Regular method — `this` is whatever called it
    increment() { this.count++; }

    // Arrow function as a class field — `this` is permanently bound to
    // the instance. Required when you'll pass the method as a callback
    // (e.g. as an onClick handler) because otherwise `this` would be lost.
    onClick = () => {
        this.count++;
    };
}
```

We use the arrow-function-as-field form for any method that gets passed as a callback to an event handler or `setInterval` — because in JavaScript, *how a method is called* determines what `this` is, not which class it's defined on. Arrow functions sidestep this by capturing `this` from the surrounding scope at the time they're defined.

## 4. Objects and destructuring

JS objects are dictionaries with named string keys (and sometimes Symbols):

```js
const point = { x: 5, y: 10 };
point.x;        // 5
point['x'];     // also 5
```

**Destructuring** unpacks fields by name in one line:

```js
const { x, y } = point;         // creates local consts x = 5, y = 10
const { x: px, y: py } = point; // rename: px = 5, py = 10

// You will see lots of this in our render() methods:
const { tagPath, showTagName, valuePrecision } = this.props.props;
```

**Spread** copies all fields from one object into another:

```js
const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };   // b = { x: 1, y: 2, z: 3 }

// Later values override earlier ones — used for default-then-override patterns:
const style = { ...defaultStyle, ...userStyle };
```

## 5. Arrays and array methods

```js
const xs = [1, 2, 3];
xs.length;          // 3
xs[0];              // 1
xs.push(4);         // mutates xs to [1, 2, 3, 4]

// Higher-order methods (don't mutate, return a new array):
const doubled  = xs.map(x => x * 2);          // [2, 4, 6, 8]
const evens    = xs.filter(x => x % 2 === 0); // [2, 4]
const sum      = xs.reduce((acc, x) => acc + x, 0); // 10

// Spread also works on arrays:
const a = [1, 2];
const b = [...a, 3, 4]; // [1, 2, 3, 4]

// "Rest" in a function: collect remaining args into an array
function sum(...nums) { return nums.reduce((a, b) => a + b, 0); }
```

You will see `arr.forEach(item => ...)` for side-effect iteration, and `arr.map(...)` when you want a transformed copy.

## 6. Equality: `==` vs `===`

Always use `===` (and `!==`). The double-equals does type coercion and is a famous source of bugs:

```js
0 == false        // true  (😱)
0 === false       // false
'5' == 5          // true  (😱)
'5' === 5         // false
```

Use `==` only when you specifically want "null OR undefined" — `if (x == null)` is the idiomatic way to check both at once.

## 7. `null` vs `undefined`

JS has two "nothing" values:

- `undefined` — variable declared but no value, function with no `return`, missing object property.
- `null` — explicit "no value", set on purpose.

In practice, treat them similarly: `if (x == null)` matches both, `if (x === null)` matches only `null`, `if (x === undefined)` matches only `undefined`.

## 8. Promises: how async works

JavaScript has no threads. Anything that takes time (network calls, timers) is **asynchronous**: it kicks off a task and continues. The result arrives later via a callback.

The modern wrapper is a **Promise**, an object that represents a future value. The most important methods are `.then()` (run when the value arrives), `.catch()` (run on error), and `.finally()` (run either way).

```js
// `fetch` returns a Promise<Response>. Response.json() returns Promise<any>.
fetch('/data/simpletagdisplay/readTag?tagPath=[default]X')
    .then(response => response.json())  // chain returns the next Promise
    .then(data => {
        if (data.success) {
            console.log('Got value:', data.value);
        }
    })
    .catch(err => {
        console.error('Read failed:', err);
    });
```

`Promise.all([p1, p2, ...])` runs promises in parallel and resolves once they're all done:

```js
Promise.all([
    fetchJson('/trendList'),
    fetchJson('/tagHistory?tagPaths=...'),
]).then(([trendData, historyData]) => {
    // both responses available here
});
```

**You will not see `async` / `await` in our code.** It's a newer, cleaner syntax for the same thing, but we stuck with `.then()` chains throughout for consistency.

## 9. The DOM and events

The **DOM** ("Document Object Model") is the tree of HTML elements the browser displays. JS can read it, modify it, and listen to events on it.

```js
const button = document.querySelector('#myButton');     // CSS selector
button.addEventListener('click', e => alert('clicked'));

// Remove a listener later
button.removeEventListener('click', myHandler);
```

The `window` object is the global JS namespace and also represents the browser tab. We use it for cross-component messaging:

```js
// In SimpleTagDisplay, after adding a tag to the trend list:
window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'));

// In CtgChart's componentDidMount:
window.addEventListener('ctg-trend-list-changed', () => this.initialLoad());
```

This is the *only* link between the two components — no shared state, no Perspective binding.

## 10. React-style components (very brief)

Perspective wraps a custom version of [React](https://react.dev). For our purposes:

- A **component** is a JS class extending `Component`.
- The class has a **`render()`** method that returns a tree of `React.createElement(...)` calls, which describe the HTML the browser should produce.
- It has **`state`**: a plain object with values that, when changed via `this.setState({...})`, trigger a re-render.
- It has **`props`**: read-only inputs from the parent (Perspective gives us bindings here).
- It has **lifecycle methods**:
  - `componentDidMount()` — runs once after the component is first put into the DOM. Good place to start timers or fetch initial data.
  - `componentDidUpdate(prevProps, prevState)` — runs after every re-render (after the first). Compare current and previous to react to changes.
  - `componentWillUnmount()` — runs once before the component is removed. Clean up timers and event listeners here, or you'll leak.

Quick example:

```js
class Counter extends Component {
    constructor(props) {
        super(props);
        this.state = { count: 0 };
    }

    increment = () => this.setState({ count: this.state.count + 1 });

    componentDidMount() {
        this.timer = setInterval(() => this.increment(), 1000);
    }

    componentWillUnmount() {
        clearInterval(this.timer);  // CRITICAL — otherwise the timer leaks
    }

    render() {
        return React.createElement('div', null, 'Count: ' + this.state.count);
    }
}
```

Three rules to remember when reading our `render()` methods:

1. `React.createElement(tag, props, ...children)` is the same as the HTML tag `<div>` etc. The second arg is an object of attributes; the rest are children.
2. **Never mutate `this.state` directly.** Always go through `this.setState({...})` — that's what tells React to re-render.
3. `setState` is *asynchronous*. If you need to do something after the new state is committed, use the second-argument callback: `this.setState({ x: 1 }, () => { /* runs after */ })`.

## 11. `JSON.parse` / `JSON.stringify`

JS has built-in JSON support. Use these for converting between JS objects and strings — for example, when sending fetch bodies or storing in localStorage.

```js
const obj = JSON.parse('{"a": 1}');           // { a: 1 }
const str = JSON.stringify({ b: 2 });          // '{"b":2}'
```

## 12. Things you can mostly ignore (for reading our code)

- **`typeof`, `instanceof`** — type checks. You'll see them in defensive code.
- **`Array.isArray(x)`** — proper way to check for arrays (because `typeof []` is `'object'`).
- **Truthy/falsy** — `if (x)` is true when `x` is anything other than `0`, `''`, `null`, `undefined`, `NaN`, or `false`. We use this constantly to mean "if it has a value".

## 13. A worked example

Putting it together — here's the classic `fetch` + `.then()` shape, annotated. (In the live code, `SimpleTagDisplay` no longer fetches its own value this way — it subscribes to the shared `TagReadPoller`, which does one batched `/readTags` fetch for the whole page. But the poller's own request uses exactly this pattern, so it's still the shape to learn.)

```js
readTagValue() {
    // Destructure: get `tagPath` out of this.props.props.
    // `this.props` is what Perspective gave us; `.props` is our own prop object
    // (because Perspective wraps it once).
    const { props } = this.props;
    const { tagPath } = props;

    // Guard: no tag configured → put a marker into state and stop.
    if (!tagPath || !tagPath.trim()) {
        this.setState({ tagValue: 'No Tag Path', isConnected: false });
        return;
    }

    // Build the URL — encodeURIComponent escapes things like [, ], /
    const url = `/data/simpletagdisplay/readTag?tagPath=${encodeURIComponent(tagPath)}`;

    // Kick off the network call. fetch returns a Promise<Response>.
    fetch(url)
        // Response.json() also returns a Promise. .then() chains them.
        .then(response => response.json())
        .then(data => {
            // `data` is { success, value, quality, isGood } from the gateway
            if (data && data.success && data.isGood) {
                this.setState({ tagValue: data.value, isConnected: true });
            } else {
                this.setState({ tagValue: 'Bad Quality', isConnected: false });
            }
        })
        .catch(error => {
            this.setState({ tagValue: 'Error: ' + error.message, isConnected: false });
        });
}
```

The actual poller has fallback-URL logic and batching on top of this, but the shape is the same.

---

Equipped with these 13 things, you can read [simpletagdisplay.js](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js) without serious trouble. Continue to [04-frontend-javascript.md](04-frontend-javascript.md) for the file-level walkthrough.
