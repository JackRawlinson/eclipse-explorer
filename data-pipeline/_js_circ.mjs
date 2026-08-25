// Helper for verify_circumstances.py --js: evaluate the browser's implementation
// over a list of points and print the results as JSON.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , modulePath, geojsonPath, pointsJson] = process.argv;
const { localCircumstances, toUT } =
  await import(pathToFileURL(modulePath).href);

const el = JSON.parse(readFileSync(geojsonPath, 'utf8')).properties.elements;
const points = JSON.parse(pointsJson);

console.log(JSON.stringify(points.map(([lat, lon]) => {
  const r = localCircumstances(el, lat, lon);
  if (!r) return null;
  return {
    ut: toUT(el, r.tMax),
    magnitude: r.magnitude,
    obscuration: r.obscuration,
    sunAlt: r.sunAlt,
    duration: r.durationS ?? null,
    c1: r.c1 !== undefined ? toUT(el, r.c1) : null,
    c4: r.c4 !== undefined ? toUT(el, r.c4) : null,
  };
})));
