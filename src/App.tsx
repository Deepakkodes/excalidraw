import { useEffect, useRef, useState } from 'react'
import {
  Excalidraw,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  loadFromBlob,
  viewportCoordsToSceneCoords,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import {
  createBoard,
  getBoard,
  listBoards,
  removeBoard,
  renameBoard,
  saveSnapshot,
  type BoardRecord,
  type BoardSummary,
} from './boardStore'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { eraseCircle } from './partialErase'
import { recognizeShape, roundPolygon, smoothPath } from './shapeRecognizer'
import '@excalidraw/excalidraw/index.css'
import './App.css'

const EMPTY_SCENE = serializeAsJSON([], {}, {}, 'local')

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}

function cleanName(name: string) {
  return name.trim() || 'Untitled board'
}

function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [activeBoard, setActiveBoard] = useState<BoardRecord | null>(null)
  const [isFilesOpen, setIsFilesOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [canvasVersion, setCanvasVersion] = useState(0)
  const [isRecoverOpen, setIsRecoverOpen] = useState(false)
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete' | null>(null)
  const [dialogName, setDialogName] = useState('')
  const [penSize, setPenSize] = useState(2)
  const [scaleWithZoom, setScaleWithZoom] = useState(true)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const zoomRef = useRef(1)
  const penRef = useRef({ penSize: 2, scaleWithZoom: true })
  const changeTimerRef = useRef<number | undefined>(undefined)
  const [drawToShape, setDrawToShape] = useState(true)
  const drawToShapeRef = useRef(true)
  const [lineStyle, setLineStyle] = useState<'solid' | 'dashed' | 'dotted'>('solid')
  const lineStyleRef = useRef<'solid' | 'dashed' | 'dotted'>('solid')
  const [eraserActive, setEraserActive] = useState(false)
  const [partialErase, setPartialErase] = useState(false)
  const [eraserSize, setEraserSize] = useState(14)
  const eraserActiveRef = useRef(false)
  const partialEraseRef = useRef(false)
  const eraserSizeRef = useRef(14)
  const erasingFromRef = useRef<[number, number] | null>(null)
  const pendingStrokeRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const latestSceneRef = useRef(EMPTY_SCENE)
  const activeBoardIdRef = useRef<string | undefined>(undefined)

  const refreshBoards = async () => setBoards(await listBoards())

  const openBoard = async (id: string) => {
    setIsLoading(true)
    const board = await getBoard(id)
    if (board) {
      latestSceneRef.current = board.snapshots.at(-1)?.scene ?? EMPTY_SCENE
      activeBoardIdRef.current = board.id
      setActiveBoard(board)
      setCanvasVersion((version) => version + 1)
      setIsFilesOpen(false)
    }
    setIsLoading(false)
  }

  useEffect(() => {
    const initialise = async () => {
      const savedBoards = await listBoards()
      if (savedBoards.length) {
        await openBoard(savedBoards[0].id)
      } else {
        const board = await createBoard('My first board', EMPTY_SCENE)
        latestSceneRef.current = EMPTY_SCENE
        activeBoardIdRef.current = board.id
        setActiveBoard(board)
      }
      await refreshBoards()
      setIsLoading(false)
    }
    void initialise()
    return () => { window.clearTimeout(saveTimerRef.current); window.clearTimeout(changeTimerRef.current) }
  }, [])

  const persistScene = (scene: string, boardId = activeBoard?.id) => {
    if (!boardId || latestSceneRef.current === scene) return
    latestSceneRef.current = scene
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void saveSnapshot(boardId, scene).then(async (board) => {
        if (board && board.id === activeBoardIdRef.current) setActiveBoard(board)
        await refreshBoards()
        setMessage('Saved locally')
      })
    }, 700)
  }

  const applyPenSize = (size = penRef.current.penSize, zoom = zoomRef.current) => {
    const api = apiRef.current
    if (!api) return
    const width = penRef.current.scaleWithZoom ? size / zoom : size
    const next = Math.max(0.1, Math.round(width * 100) / 100)
    if (api.getAppState().currentItemStrokeWidth !== next) {
      api.updateScene({ appState: { currentItemStrokeWidth: next } })
    }
  }

  const snapStroke = (id: string) => {
    const api = apiRef.current
    if (!api) return
    const all = api.getSceneElementsIncludingDeleted()
    const stroke = all.find((el) => el.id === id)
    if (!stroke || stroke.isDeleted || stroke.type !== 'freedraw') return
    const absolute = stroke.points.map(([x, y]) => [stroke.x + x, stroke.y + y] as [number, number])
    const recognized = drawToShapeRef.current ? recognizeShape(absolute) : null
    // Pen strokes can't be dashed/dotted, so in those modes an unrecognised stroke becomes a smoothed curve that can.
    if (!recognized && lineStyleRef.current === 'solid') return
    if (recognized?.kind === 'polygon') recognized.points = roundPolygon(recognized.points.slice(0, -1))
    const shape = recognized ?? { kind: 'line' as const, points: smoothPath(absolute, Math.min(absolute.length - 1, 30)) }
    const style = { strokeColor: stroke.strokeColor, backgroundColor: stroke.backgroundColor, fillStyle: stroke.fillStyle, strokeWidth: Math.max(0.5, stroke.strokeWidth), strokeStyle: lineStyleRef.current, roughness: 1, opacity: stroke.opacity }
    const [created] = convertToExcalidrawElements([
      'points' in shape
        ? { type: shape.kind === 'arrow' ? 'arrow' : 'line', ...(shape.kind === 'line' && shape.points.length > 2 ? { roundness: { type: 2 as const } } : {}), ...(shape.kind === 'arrow' ? { endArrowhead: 'arrow' as const, ...(shape.points.length > 2 ? { roundness: { type: 2 as const } } : {}) } : {}), x: shape.points[0][0], y: shape.points[0][1], points: shape.points.map(([x, y]) => [x - shape.points[0][0], y - shape.points[0][1]] as [number, number]), ...style }
        : { type: shape.kind, x: shape.x, y: shape.y, width: shape.width, height: shape.height, ...(shape.kind === 'ellipse' ? {} : { roundness: { type: 3 as const } }), ...style },
    ])
    api.updateScene({
      elements: [...all.map((el) => (el.id === id ? { ...el, isDeleted: true, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : el)), created],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }

  const eraseTo = (event: React.PointerEvent) => {
    const api = apiRef.current
    const from = erasingFromRef.current
    if (!api || !from) return
    const state = api.getAppState()
    const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, state)
    const radius = eraserSizeRef.current / state.zoom.value
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], y - from[1]) / (radius * 0.5)))
    let elements = api.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[]
    let changed = false
    for (let i = 1; i <= steps; i++) {
      const next = eraseCircle(elements, from[0] + ((x - from[0]) * i) / steps, from[1] + ((y - from[1]) * i) / steps, radius)
      if (next) { elements = next; changed = true }
    }
    erasingFromRef.current = [x, y]
    if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY })
  }

  const isPartialEraseEvent = (event: React.PointerEvent) =>
    partialEraseRef.current && eraserActiveRef.current && event.target instanceof HTMLCanvasElement

  const finishErase = (event: React.PointerEvent) => {
    if (!erasingFromRef.current) return
    event.stopPropagation()
    erasingFromRef.current = null
    const api = apiRef.current
    if (api) api.updateScene({ elements: api.getSceneElementsIncludingDeleted(), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }

  const handleChange = (elements: Parameters<typeof serializeAsJSON>[0], appState: AppState, files: BinaryFiles) => {
    if (appState.zoom.value !== zoomRef.current) {
      zoomRef.current = appState.zoom.value
      applyPenSize()
    }
    const eraser = appState.activeTool.type === 'eraser'
    if (eraser !== eraserActiveRef.current) { eraserActiveRef.current = eraser; setEraserActive(eraser) }
    const drawing = appState.newElement
    if (drawing?.type === 'freedraw') {
      pendingStrokeRef.current = drawing.id
    } else if (!drawing && pendingStrokeRef.current) {
      const id = pendingStrokeRef.current
      pendingStrokeRef.current = null
      if (drawToShapeRef.current || lineStyleRef.current !== 'solid') window.setTimeout(() => snapStroke(id), 0)
    }
    // Serialising the whole scene on every pointer move causes the lag; wait until input pauses.
    window.clearTimeout(changeTimerRef.current)
    changeTimerRef.current = window.setTimeout(() => persistScene(serializeAsJSON(elements, appState, files, 'local')), 250)
  }

  const handleNewBoard = () => { setDialogName(''); setDialog('new') }
  const handleRename = () => { if (activeBoard) { setDialogName(activeBoard.name); setDialog('rename') } }
  const handleDelete = () => { if (activeBoard) setDialog('delete') }

  const confirmDialog = async () => {
    const kind = dialog
    setDialog(null)
    if (kind === 'new') {
      const board = await createBoard(cleanName(dialogName), EMPTY_SCENE)
      await refreshBoards()
      await openBoard(board.id)
    } else if (kind === 'rename' && activeBoard) {
      const board = await renameBoard(activeBoard.id, cleanName(dialogName))
      if (board) setActiveBoard(board)
      await refreshBoards()
    } else if (kind === 'delete' && activeBoard) {
      await removeBoard(activeBoard.id)
      const remaining = await listBoards()
      if (remaining.length) {
        await openBoard(remaining[0].id)
      } else {
        const board = await createBoard('My first board', EMPTY_SCENE)
        latestSceneRef.current = EMPTY_SCENE
        activeBoardIdRef.current = board.id
        setActiveBoard(board)
        setCanvasVersion((version) => version + 1)
      }
      await refreshBoards()
    }
  }

  const handleExport = () => {
    if (!activeBoard) return
    const blob = new Blob([latestSceneRef.current], { type: 'application/vnd.excalidraw+json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${activeBoard.name.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'board'}.excalidraw`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const scene = await loadFromBlob(file, null, null)
      const serialisedScene = serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')
      const board = await createBoard(cleanName(file.name.replace(/\.excalidraw$/i, '')), serialisedScene)
      await refreshBoards()
      await openBoard(board.id)
      setMessage('Board imported')
    } catch {
      setMessage('That file could not be imported')
    }
  }

  const restoreSnapshot = async (scene: string) => {
    if (!activeBoard) return
    const board = await saveSnapshot(activeBoard.id, scene)
    if (board) {
      latestSceneRef.current = scene
      setActiveBoard(board)
      setCanvasVersion((version) => version + 1)
      await refreshBoards()
      setIsFilesOpen(false)
      setMessage('Recovered saved version')
    }
  }

  const latestScene = activeBoard?.snapshots.at(-1)?.scene ?? EMPTY_SCENE

  return (
    <main className="workspace">
      <header className="filebar">
        <button className="brand" onClick={() => setIsFilesOpen((open) => !open)} type="button">
          <span className="brand-mark">*</span> Boards
        </button>
        <div className="board-title">
          <span>{activeBoard?.name ?? 'Loading board...'}</span>
          <small>{message || 'Autosaves to this browser'}</small>
        </div>
        <div className="pen-controls" title="Pen thickness (applies to new strokes)">
          <label>Pen <input type="range" min="0.1" max="8" step="0.1" value={penSize} onChange={(e) => { const v = Number(e.target.value); setPenSize(v); penRef.current.penSize = v; applyPenSize(v) }} /></label>
          <label title="Stroke style for shapes (new shapes and snapped drawings)">Stroke <select value={lineStyle} onChange={(e) => { const v = e.target.value as 'solid' | 'dashed' | 'dotted'; setLineStyle(v); lineStyleRef.current = v; apiRef.current?.updateScene({ appState: { currentItemStrokeStyle: v } }) }}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label>
          <label title="Snap hand-drawn lines, rectangles, circles and triangles into perfect shapes"><input type="checkbox" checked={drawToShape} onChange={(e) => { setDrawToShape(e.target.checked); drawToShapeRef.current = e.target.checked }} /> Draw to shape</label>
          <label className="zoom-lock"><input type="checkbox" checked={scaleWithZoom} onChange={(e) => { setScaleWithZoom(e.target.checked); penRef.current.scaleWithZoom = e.target.checked; applyPenSize() }} /> Zoom-aware</label>
        </div>
        <div className="file-actions">
          <button onClick={handleExport} type="button">Export</button>
          <button onClick={() => fileInputRef.current?.click()} type="button">Import</button>
          <input ref={fileInputRef} accept=".excalidraw,application/json" hidden onChange={handleImport} type="file" />
        </div>
      </header>

      {isFilesOpen && (
        <aside className="file-panel" aria-label="Board files">
          <div className="panel-heading"><h1>Boards</h1><button className="primary" onClick={handleNewBoard} type="button">+ New</button></div>
          <div className="board-list">
            {boards.map((board) => (
              <div className={board.id === activeBoard?.id ? 'board-item active' : 'board-item'} key={board.id}>
                <button className={board.id === activeBoard?.id ? 'board-row active' : 'board-row'} onClick={() => void openBoard(board.id)} type="button">
                  <strong>{board.name}</strong><small>Updated {formatDate(board.updatedAt)}</small>
                </button>
                {board.id === activeBoard?.id && (
                  <div className="board-actions"><button aria-label="Rename board" title="Rename" onClick={handleRename} type="button"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button aria-label="Delete board" title="Delete" className="danger" onClick={handleDelete} type="button"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg></button></div>
                )}
              </div>
            ))}
          </div>
          {activeBoard && (
            <>
              <div className="panel-section"><button className="recover-toggle" aria-expanded={isRecoverOpen} onClick={() => setIsRecoverOpen((open) => !open)} type="button"><span>Recover autosave</span><span className="chevron">{isRecoverOpen ? '▾' : '▸'}</span></button>{isRecoverOpen && <><p>Restore one of the last {activeBoard.snapshots.length} saved versions.</p><div className="snapshot-list">
                {activeBoard.snapshots.slice(0, -1).reverse().map((snapshot) => <button key={snapshot.id} onClick={() => void restoreSnapshot(snapshot.scene)} type="button">Restore {formatDate(snapshot.createdAt)}</button>)}
                {activeBoard.snapshots.length < 2 && <small>No earlier saved version yet.</small>}
              </div></>}</div>
            </>
          )}
        </aside>
      )}

      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => setDialog(null)}>
          <form className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setDialog(null) }} onSubmit={(e) => { e.preventDefault(); void confirmDialog() }}>
            <h2>{dialog === 'new' ? 'New board' : dialog === 'rename' ? 'Rename board' : 'Delete board'}</h2>
            {dialog === 'delete' ? (
              <p>Delete <strong>{activeBoard?.name}</strong>? This can't be undone.</p>
            ) : (
              <>
                <p>{dialog === 'new' ? 'Give your new board a name.' : 'Choose a new name for this board.'}</p>
                <input autoFocus maxLength={80} onChange={(e) => setDialogName(e.target.value)} onFocus={(e) => e.target.select()} placeholder="Untitled board" value={dialogName} />
              </>
            )}
            <div className="modal-actions">
              <button onClick={() => setDialog(null)} type="button">Cancel</button>
              <button className={dialog === 'delete' ? 'primary danger-solid' : 'primary'} type="submit">{dialog === 'new' ? 'Create' : dialog === 'rename' ? 'Save' : 'Delete'}</button>
            </div>
          </form>
        </div>
      )}

      {eraserActive && (
        <div className="eraser-bar" role="group" aria-label="Eraser mode">
          <span>Eraser</span>
          <button className={partialErase ? '' : 'on'} onClick={() => { setPartialErase(false); partialEraseRef.current = false }} type="button">Whole shape</button>
          <button className={partialErase ? 'on' : ''} onClick={() => { setPartialErase(true); partialEraseRef.current = true }} type="button">Partial</button>
          {partialErase && <label>Size <input type="range" min="6" max="48" value={eraserSize} onChange={(e) => { const v = Number(e.target.value); setEraserSize(v); eraserSizeRef.current = v }} /></label>}
        </div>
      )}

      <section
        className={eraserActive && partialErase ? 'canvas partial-erase' : 'canvas'}
        aria-busy={isLoading}
        onPointerDownCapture={(e) => {
          if (e.button !== 0 || !isPartialEraseEvent(e) || !apiRef.current) return
          e.stopPropagation()
          e.preventDefault()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, apiRef.current.getAppState())
          erasingFromRef.current = [x, y]
          eraseTo(e)
        }}
        onPointerMoveCapture={(e) => { if (erasingFromRef.current) { e.stopPropagation(); eraseTo(e) } }}
        onPointerUpCapture={finishErase}
        onPointerCancelCapture={finishErase}
      >
        {!isLoading && activeBoard && <Excalidraw key={`${activeBoard.id}-${canvasVersion}`} theme="light" initialData={async () => loadFromBlob(new Blob([latestScene], { type: 'application/vnd.excalidraw+json' }), null, null)} excalidrawAPI={(api) => { apiRef.current = api; applyPenSize() }} onChange={handleChange} />}
      </section>
    </main>
  )
}

export default App
