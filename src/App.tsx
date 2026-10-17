import { useEffect, useRef, useState } from 'react'
import {
  Excalidraw,
  loadFromBlob,
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
  const [isDarkMode, setIsDarkMode] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [isLoading, setIsLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [canvasVersion, setCanvasVersion] = useState(0)
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
    return () => window.clearTimeout(saveTimerRef.current)
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

  const handleNewBoard = async () => {
    const name = window.prompt('Name your new board', 'Untitled board')
    if (name === null) return
    const board = await createBoard(cleanName(name), EMPTY_SCENE)
    await refreshBoards()
    await openBoard(board.id)
  }

  const handleRename = async () => {
    if (!activeBoard) return
    const name = window.prompt('Rename board', activeBoard.name)
    if (name === null) return
    const board = await renameBoard(activeBoard.id, cleanName(name))
    if (board) setActiveBoard(board)
    await refreshBoards()
  }

  const handleDelete = async () => {
    if (!activeBoard || !window.confirm(`Delete "${activeBoard.name}"?`)) return
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
    <main className={isDarkMode ? 'workspace dark' : 'workspace'}>
      <header className="filebar">
        <button className="brand" onClick={() => setIsFilesOpen((open) => !open)} type="button">
          <span className="brand-mark">*</span> Boards
        </button>
        <div className="board-title">
          <span>{activeBoard?.name ?? 'Loading board...'}</span>
          <small>{message || 'Autosaves to this browser'}</small>
        </div>
        <div className="file-actions">
          <button aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setIsDarkMode((enabled) => !enabled)} type="button">
            {isDarkMode ? 'Light' : 'Dark'}
          </button>
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
              <button className={board.id === activeBoard?.id ? 'board-row active' : 'board-row'} key={board.id} onClick={() => void openBoard(board.id)} type="button">
                <strong>{board.name}</strong><small>Updated {formatDate(board.updatedAt)}</small>
              </button>
            ))}
          </div>
          {activeBoard && (
            <>
              <div className="panel-section"><h2>Current board</h2><div className="button-row"><button onClick={handleRename} type="button">Rename</button><button className="danger" onClick={handleDelete} type="button">Delete</button></div></div>
              <div className="panel-section"><h2>Recover autosave</h2><p>Restore one of the last {activeBoard.snapshots.length} saved versions.</p><div className="snapshot-list">
                {activeBoard.snapshots.slice(0, -1).reverse().map((snapshot) => <button key={snapshot.id} onClick={() => void restoreSnapshot(snapshot.scene)} type="button">Restore {formatDate(snapshot.createdAt)}</button>)}
                {activeBoard.snapshots.length < 2 && <small>No earlier saved version yet.</small>}
              </div></div>
            </>
          )}
        </aside>
      )}

      <section className="canvas" aria-busy={isLoading}>
        {!isLoading && activeBoard && <Excalidraw key={`${activeBoard.id}-${canvasVersion}`} theme={isDarkMode ? 'dark' : 'light'} initialData={async () => loadFromBlob(new Blob([latestScene], { type: 'application/vnd.excalidraw+json' }), null, null)} onChange={(elements, appState, files) => persistScene(serializeAsJSON(elements, appState, files, 'local'))} />}
      </section>
    </main>
  )
}

export default App
