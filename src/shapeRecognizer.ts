type Pt = [number, number]

export type RecognizedShape =
  | { kind: 'line' | 'arrow'; points: Pt[] }
  | { kind: 'polygon'; points: Pt[] }
  | { kind: 'rectangle' | 'ellipse' | 'diamond'; x: number; y: number; width: number; height: number }

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

function pointToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (!len2) return dist(p, a)
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return dist(p, [a[0] + t * dx, a[1] + t * dy])
}

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const build = (list: Pt[]) => {
    const out: Pt[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...build(pts), ...build([...pts].reverse())]
}

const polyArea = (poly: Pt[]) => Math.abs(poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + p[0] * q[1] - q[0] * p[1] }, 0)) / 2

function lineIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1]
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((c[0] - a[0]) * d2y - (c[1] - a[1]) * d2x) / den
  return [a[0] + t * d1x, a[1] + t * d1y]
}

/** Smallest enclosing polygon with `target` corners: repeatedly drop the edge whose removal adds the least area. */
function circumscribe(hull: Pt[], target: number): Pt[] | null {
  let poly = hull
  while (poly.length > target) {
    const n = poly.length
    let best = -1
    let bestPoint: Pt | null = null
    let bestCost = Infinity
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      const x = lineIntersection(poly[(i - 1 + n) % n], a, b, poly[(i + 2) % n])
      if (!x || cross(a, b, x) >= 0) continue // lines must converge on the outer side of this edge
      const cost = Math.abs(cross(a, x, b)) / 2
      if (cost < bestCost) { bestCost = cost; best = i; bestPoint = x }
    }
    if (best < 0 || !bestPoint) return null
    const next = (best + 1) % n
    poly = poly.flatMap((p, i) => (i === best ? [bestPoint!] : i === next ? [] : [p]))
  }
  return poly
}

function arcLengths(points: Pt[]) {
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]))
  return cum
}

/** Evenly spaced, lightly averaged copy of a stroke, so wobbly pen paths become smooth curves. */
export function smoothPath(points: Pt[], count: number): Pt[] {
  const cum = arcLengths(points)
  const total = cum[cum.length - 1]
  if (points.length < 3 || total === 0) return points
  const at = (len: number): Pt => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < len) i++
    const f = (len - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9)
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f]
  }
  const reach = total / count
  return Array.from({ length: count + 1 }, (_, k) => {
    const len = (total * k) / count
    if (k === 0) return points[0]
    if (k === count) return points[points.length - 1]
    const samples = [at(Math.max(0, len - reach * 0.5)), at(len), at(Math.min(total, len + reach * 0.5))]
    return [samples.reduce((s, p) => s + p[0], 0) / 3, samples.reduce((s, p) => s + p[1], 0) / 3] as Pt
  })
}

/** A long open stroke that ends in a sharp turn-back (the arrowhead). The shaft may be straight or curved. */
function detectArrow(points: Pt[], thin: boolean): Pt[] | null {
  const cum = arcLengths(points)
  const total = cum[cum.length - 1]
  const start = points[0]
  if (total < 80) return null
  const w = Math.max(8, total * 0.05)
  const indexAt = (len: number) => {
    let i = 0
    while (i < points.length - 1 && cum[i] < len) i++
    return i
  }

  let tipIndex = -1
  for (let i = 1; i < points.length - 1; i++) {
    if (cum[i] < total * (thin ? 0.3 : 0.5)) continue
    if (total - cum[i] < w * 0.6) break
    const from = points[indexAt(cum[i] - w)]
    const to = points[indexAt(cum[i] + w)]
    const v1: Pt = [points[i][0] - from[0], points[i][1] - from[1]]
    const v2: Pt = [to[0] - points[i][0], to[1] - points[i][1]]
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1])
    if (!l1 || !l2) continue
    const turn = (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180) / Math.PI
    if (turn >= (thin ? 90 : 110)) { tipIndex = i; break }
  }
  if (tipIndex < 0) return null

  const tip = points[tipIndex]
  const shaftLen = cum[tipIndex]
  const rest = points.slice(tipIndex + 1)
  const wing = Math.max(...rest.map((p) => dist(p, tip)))
  if (total - shaftLen > shaftLen * (thin ? 1.5 : 0.7) || wing < shaftLen * 0.06) return null
  if (dist(points[points.length - 1], start) < dist(tip, start) * 0.3) return null // came back to the start: a shape, not an arrow

  const body = points.slice(0, tipIndex + 1)
  const bendDev = Math.max(...body.map((p) => pointToSegment(p, start, tip)))
  if (bendDev < shaftLen * 0.06) return [start, tip]
  return smoothPath(body, 6)
}

/** Points are absolute coordinates. Returns null when the stroke isn't clearly a shape. */
export function recognizeShape(points: Pt[]): RecognizedShape | null {
  if (points.length < 6) return null
  let pathLen = 0
  for (let i = 1; i < points.length; i++) pathLen += dist(points[i - 1], points[i])
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const width = maxX - minX
  const height = maxY - minY
  const diag = Math.hypot(width, height)
  if (diag < 25) return null

  const first = points[0]
  const last = points[points.length - 1]

  // Long, skinny outlines are arrows or lines, never triangles/rectangles, whichever way round they were drawn.
  const thin = polyArea(convexHull(points)) / (diag * diag) < 0.14
  const arrow = detectArrow(points, thin) ?? (thin ? detectArrow([...points].reverse(), thin) : null)
  if (arrow) return { kind: 'arrow', points: arrow }
  if (thin) return null

  // Closed = the end of the stroke comes back to (or crosses) the beginning, so overshoots and gaps both count.
  const n = points.length
  const head = points.slice(0, Math.ceil(n * 0.4))
  const tail = points.slice(Math.floor(n * 0.6))
  const closed = head.some((a) => tail.some((b) => dist(a, b) < diag * 0.12))

  if (!closed) {
    const chord = dist(first, last)
    const maxDev = Math.max(...points.map((p) => pointToSegment(p, first, last)))
    return chord > diag * 0.8 && maxDev < chord * 0.08 ? { kind: 'line', points: [first, last] } : null
  }

  const cx = minX + width / 2
  const cy = minY + height / 2
  const box = { x: minX, y: minY, width, height }
  const hull = convexHull(points)
  if (hull.length < 3) return null
  const hullArea = polyArea(hull)

  const ellipseError = width > 10 && height > 10
    ? points.reduce((sum, p) => sum + Math.abs(Math.hypot((p[0] - cx) / (width / 2), (p[1] - cy) / (height / 2)) - 1), 0) / points.length
    : Infinity
  if (ellipseError < 0.07) return { kind: 'ellipse', ...box }

  const tri = circumscribe(hull, 3)
  if (tri && (polyArea(tri) - hullArea) / polyArea(tri) < 0.16) return { kind: 'polygon', points: [...tri, tri[0]] }

  const quad = circumscribe(hull, 4)
  if (quad && (polyArea(quad) - hullArea) / polyArea(quad) < 0.16) {
    const fill = polyArea(quad) / (width * height)
    if (fill > 0.7) return { kind: 'rectangle', ...box }
    const mids: Pt[] = [[cx, minY], [maxX, cy], [cx, maxY], [minX, cy]]
    if (mids.every((m) => quad.some((q) => dist(q, m) < diag * 0.2))) return { kind: 'diamond', ...box }
    return { kind: 'polygon', points: [...quad, quad[0]] }
  }

  return ellipseError < 0.11 ? { kind: 'ellipse', ...box } : null
}

/** Ramer-Douglas-Peucker: drops points that lie within `epsilon` of the straight path. */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points
  let maxDist = 0
  let index = 0
  const first = points[0]
  const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegment(points[i], first, last)
    if (d > maxDist) { maxDist = d; index = i }
  }
  if (maxDist <= epsilon) return [first, last]
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)]
}

/** Closed polygon with softly rounded corners, returned as a closed point list. */
export function roundPolygon(corners: Pt[], ratio = 0.14): Pt[] {
  const n = corners.length
  const shortest = Math.min(...corners.map((c, i) => dist(c, corners[(i + 1) % n])))
  const radius = shortest * ratio
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n], c = corners[i], next = corners[(i + 1) % n]
    const lp = dist(prev, c), ln = dist(c, next)
    const d = Math.min(radius, lp / 2, ln / 2)
    const a: Pt = [c[0] + ((prev[0] - c[0]) / lp) * d, c[1] + ((prev[1] - c[1]) / lp) * d]
    const b: Pt = [c[0] + ((next[0] - c[0]) / ln) * d, c[1] + ((next[1] - c[1]) / ln) * d]
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, u = 1 - t
      out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
    }
  }
  return [...out, out[0]]
}
