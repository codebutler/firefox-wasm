// Minimal probe: force full engine init paths + print a marker.
var o = { a: 1, b: [1, 2, 3] };
print("startup-probe ok " + o.b.map(function (x) { return x * 2; }).join(","));
