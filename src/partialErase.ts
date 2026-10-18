import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { simplify } from './shapeRecognizer'

type Pt = [number, number]

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

function rotate(points: Pt[], cx: number, cy: number, angle: number): Pt[] {
  if (!angle) return points
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return points.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos])
}

/** Smooth curve through the points, matching how rounded Excalidraw lines are drawn closely enough to cut. */
function catmullRom(points: Pt[]): Pt[] {
  if (points.length < 3) return points
  const out: Pt[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)]
    for (let s = 0; s < 12; s++) {
      const t = s / 12, t2 = t * t, t3 = t2 * t
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as Pt)
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Polygon with its corners rounded the way Excalidraw rounds rectangles and diamonds. */
function roundCorners(corners: Pt[], radius: number): Pt[] {
  const n = corners.length
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n], c = corners[i], next = corners[(i + 1) % n]
    const lp = dist(prev, c), ln = dist(c, next)
    const d = Math.min(radius, lp / 2, ln / 2)
    const a: Pt = [c[0] + ((prev[0] - c[0]) / lp) * d, c[1] + ((prev[1] - c[1]) / lp) * d]
    const b: Pt = [c[0] + ((next[0] - c[0]) / ln) * d, c[1] + ((next[1] - c[1]) / ln) * d]
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t
      out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
    }
  }
  return out
}

const cornerRadius = (el: ExcalidrawElement) => (el.roundness ? Math.min(el.width, el.height) * 0.25 : 0)

function subdivide(points: Pt[], closed: boolean, step: number): Pt[] {
  const out: Pt[] = []
  const n = points.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i], b = points[(i + 1) % n]
    const k = Math.max(1, Math.ceil(dist(a, b) / step))
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
  }
  if (!closed) out.push(points[n - 1])
  return out
}

/** Index runs of the points that survive an eraser circle, or null when the circle touches nothing. */
function surviving(points: Pt[], closed: boolean, cx: number, cy: number, r: number): number[][] | null {
  const inside = points.map((p) => dist(p, [cx, cy]) < r)
  const first = inside.indexOf(true)
  if (first < 0) return null
  const order = closed ? [...points.keys()].map((i) => (i + first) % points.length) : [...points.keys()]
  const runs: number[][] = []
  let run: number[] = []
  for (const i of order) {
    if (inside[i]) {
      if (run.length) runs.push(run)
      run = []
    } else run.push(i)
  }
  if (run.length) runs.push(run)
  return runs.filter((r2) => r2.length >= 2)
}

function outline(el: ExcalidrawElement): { points: Pt[]; closed: boolean } | null {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2
  switch (el.type) {
    case 'line':
    case 'arrow': {
      const abs = (el.points as readonly Pt[]).map(([x, y]) => [el.x + x, el.y + y] as Pt)
      return { points: rotate(el.roundness ? catmullRom(abs) : abs, cx, cy, el.angle), closed: false }
    }
    case 'rectangle': {
      const corners: Pt[] = [[el.x, el.y], [el.x + el.width, el.y], [el.x + el.width, el.y + el.height], [el.x, el.y + el.height]]
      return { points: rotate(roundCorners(corners, Math.min(cornerRadius(el), 32)), cx, cy, el.angle), closed: true }
    }
    case 'diamond': {
      const corners: Pt[] = [[cx, el.y], [el.x + el.width, cy], [cx, el.y + el.height], [el.x, cy]]
      return { points: rotate(roundCorners(corners, cornerRadius(el)), cx, cy, el.angle), closed: true }
    }
    case 'ellipse':
      return { points: rotate(Array.from({ length: 96 }, (_, i) => [cx + (el.width / 2) * Math.cos((i / 96) * Math.PI * 2), cy + (el.height / 2) * Math.sin((i / 96) * Math.PI * 2)] as Pt), cx, cy, el.angle), closed: true }
    default:
      return null
  }
}

const bump = <T extends ExcalidrawElement>(el: T, patch: Partial<ExcalidrawElement> = {}) =>
  ({ ...el, ...patch, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }) as T

/** Cuts the part of every line, arrow, shape or pen stroke under the eraser circle. Returns null if nothing was touched. */
export function eraseCircle(elements: readonly ExcalidrawElement[], cx: number, cy: number, r: number): ExcalidrawElement[] | null {
  const added: ExcalidrawElement[] = []
  let touched = false
  const next = elements.map((el) => {
    if (el.isDeleted || el.locked) return el
    if (el.type === 'freedraw') {
      if (cx < el.x - r || cx > el.x + el.width + r || cy < el.y - r || cy > el.y + el.height + r) return el
      const abs = el.points.map(([x, y]) => [el.x + x, el.y + y] as Pt)
      const runs = surviving(abs, false, cx, cy, r)
      if (!runs) return el
      touched = true
      for (const run of runs) {
        const pts = run.map((i) => abs[i])
        const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]))
        added.push({
          ...el,
          id: crypto.randomUUID(),
          x: minX,
          y: minY,
          width: Math.max(...pts.map((p) => p[0])) - minX,
          height: Math.max(...pts.map((p) => p[1])) - minY,
          points: pts.map(([x, y]) => [x - minX, y - minY]),
          pressures: el.pressures.length ? run.map((i) => el.pressures[i]) : [],
          version: 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        })
      }
      return bump(el, { isDeleted: true })
    }
    const shape = outline(el)
    if (!shape) return el
    if (el.angle === 0 && (cx < el.x - r || cx > el.x + el.width + r || cy < el.y - r || cy > el.y + el.height + r)) return el
    const dense = subdivide(shape.points, shape.closed, Math.max(r / 2, 0.5))
    const runs = surviving(dense, shape.closed, cx, cy, r)
    if (!runs) return el
    touched = true
    for (const run of runs) {
      const pts = simplify(run.map((i) => dense[i]), 0.15)
      if (pts.length < 2) continue
      const created = convertToExcalidrawElements([{
        type: 'line',
        x: pts[0][0],
        y: pts[0][1],
        points: pts.map(([x, y]) => [x - pts[0][0], y - pts[0][1]] as [number, number]),
        strokeColor: el.strokeColor,
        strokeWidth: el.strokeWidth,
        strokeStyle: el.strokeStyle,
        roughness: el.roughness,
        opacity: el.opacity,
      }])
      added.push(...(created as ExcalidrawElement[]))
    }
    return bump(el, { isDeleted: true })
  })
  return touched ? [...next, ...added] : null
}
