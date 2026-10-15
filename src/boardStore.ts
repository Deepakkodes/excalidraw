const DB_NAME = 'excalidraw-board-files'
const STORE_NAME = 'boards'
const MAX_SNAPSHOTS = 15

export type BoardSnapshot = { id: string; createdAt: number; scene: string }
export type BoardRecord = { id: string; name: string; createdAt: number; updatedAt: number; snapshots: BoardSnapshot[] }
export type BoardSummary = Pick<BoardRecord, 'id' | 'name' | 'createdAt' | 'updatedAt'>

const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const id = () => crypto.randomUUID()

export async function listBoards(): Promise<BoardSummary[]> {
  const db = await database()
  const records = await requestResult(db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll() as IDBRequest<BoardRecord[]>)
  db.close()
  return records.map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getBoard(boardId: string) {
  const db = await database()
  const board = await requestResult(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(boardId) as IDBRequest<BoardRecord | undefined>)
  db.close()
  return board
}

export async function createBoard(name: string, scene: string) {
  const now = Date.now()
  const board: BoardRecord = { id: id(), name, createdAt: now, updatedAt: now, snapshots: [{ id: id(), createdAt: now, scene }] }
  const db = await database()
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(board))
  db.close()
  return board
}

export async function saveSnapshot(boardId: string, scene: string) {
  const board = await getBoard(boardId)
  if (!board) return undefined
  const now = Date.now()
  const next: BoardRecord = { ...board, updatedAt: now, snapshots: [...board.snapshots, { id: id(), createdAt: now, scene }].slice(-MAX_SNAPSHOTS) }
  const db = await database()
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(next))
  db.close()
  return next
}

export async function renameBoard(boardId: string, name: string) {
  const board = await getBoard(boardId)
  if (!board) return undefined
  const next = { ...board, name, updatedAt: Date.now() }
  const db = await database()
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(next))
  db.close()
  return next
}

export async function removeBoard(boardId: string) {
  const db = await database()
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(boardId))
  db.close()
}
