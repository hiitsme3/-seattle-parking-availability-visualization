const svg = d3.select("#d3-basic");

const data = [30, 80, 45, 60, 20, 90, 50];

svg
  .selectAll("rect")
  .data(data)
  .join("rect")
  .attr("x", (d, i) => i * 50 + 10)
  .attr("y", (d) => 200 - d)
  .attr("width", 30)
  .attr("height", (d) => d)
  .attr("fill", "steelblue");
