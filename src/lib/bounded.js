'use strict';
// Map com teto de entradas: ao passar do limite, as mais antigas saem
// (caches de categoria, robots.txt etc. não crescem sem fim).
function setBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}
module.exports = { setBounded };
