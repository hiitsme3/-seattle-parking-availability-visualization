// Define Vega-Lite spec
const spec1 = {
  data: {
    values: [
      { a: "A", b: 28 },
      { a: "B", b: 55 },
      { a: "C", b: 43 },
    ],
  },
  mark: "bar",
  encoding: {
    x: { field: "a", type: "nominal" },
    y: { field: "b", type: "quantitative" },
  },
};

// Embed visualization in #vis div
vegaEmbed("#vl-basic", spec1, { renderer: "canvas", actions: false });
