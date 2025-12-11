# seattle-parking-availability-visualization

The files in the [public](/public) directory are deployed to: https://cse442.pages.cs.washington.edu/25au/fp/seattle-parking-availability-visualization

## External Resources (Third-Party)

Libraries used:

- Leaflet (CDN): https://leafletjs.com/
- D3 (CDN): https://d3js.org/
- Scrollama (CDN): https://github.com/russellsamora/scrollama

Map tiles & attribution:
- OpenStreetMap tiles and attribution guidelines: https://www.openstreetmap.org/copyright

References/examples consulted:
- Leaflet documentation & examples (layers, panes, circles): https://leafletjs.com/reference.html
- Scrollama documentation/examples (sticky scrollytelling + step events): https://github.com/russellsamora/scrollama
- D3 documentation (arc/pie + transitions): https://d3js.org/api


## Generative AI / AI References (Academic Integrity)

We used a generative AI assistant (ChatGPT) for conceptual guidance and debugging help while implementing scrollytelling behavior and animation/transitions. Specifically, we asked for:

- how to structure scroll-driven step events (Scrollama `onStepEnter`) and connect them to UI updates
- how to approach simple animations/transitions in JavaScript/D3 (for example: smooth updates when values change)
- troubleshooting advice for event handling and UI state toggling (for example: showing/hiding views and preventing layers from intercepting pointer events)
- whether it is possible to create an animated simulation view (for example: a simple time based/step based animation that updates counts or visuals) and how to structure the animation loop (for example: using `requestAnimationFrame` or timed intervals)
- how to design a human experience section that translates map layers into simple driver scenarios (walking time + search effort), and how to structure the UI so it switches cleanly between map steps and a scenario/animation view


Extent of use:

- AI was used to explain approaches and suggest patterns/snippets.
- We integrated changes ourselves, adapted them to our codebase, and verified behavior by testing in the browser.
- We did not use AI to generate the project’s dataset, results/claims, or write the narrative content without review.

Example of prompts that we use:

- “How do we implement scroll triggered events with Scrollama and update a Leaflet map at each step?”
- “How can we smoothly transition chart values in D3 when the underlying counts change?”
- “How do we toggle between a map view and an animation view when the user scrolls to certain steps?”
- “Is it possible to implement a simple animated simulation in JavaScript for the scrollytelling, and what’s the best way to structure the animation loop?”
- “How can we design a human experience section that translates parking supply into driver scenarios (walking time plus search effort), and what UI structure works best to switch between map steps and a scenario panel?”