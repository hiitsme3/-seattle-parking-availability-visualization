// d3.csv automatically fetches and parses CSV data
d3.csv("data.csv", (d) => ({
  category: d.category,
  value: +d.value,
})).then((data) => {
  const svg = d3.select("#d3-csv");

  const xScale = d3
    .scaleBand()
    .domain(data.map((d) => d.category))
    .range([20, 380])
    .padding(0.1);

  const yScale = d3
    .scaleLinear()
    .domain([0, d3.max(data, (d) => d.value)])
    .range([180, 20]);

  svg
    .selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", (d) => xScale(d.category))
    .attr("y", (d) => yScale(d.value))
    .attr("width", xScale.bandwidth())
    .attr("height", (d) => 180 - yScale(d.value))
    .attr("fill", "seagreen");

  svg
    .append("g")
    .attr("transform", "translate(0,180)")
    .call(d3.axisBottom(xScale));
});
