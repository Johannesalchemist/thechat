import { useState } from "react"
import Room3D from "../src/room/Room3D"

export default function Home() {
  const [mode, setMode] = useState("TEXT")

  return (
    <div style={{ height: "100vh" }}>
      {mode === "TEXT" && (
        <div style={{ padding: 40 }}>
          <h1>The Chat</h1>
          <button onClick={() => setMode("ROOM")}>
            Reflektieren
          </button>
        </div>
      )}

      {mode === "ROOM" && (
        <>
          <button onClick={() => setMode("TEXT")}>
            Zurück
          </button>
          <Room3D />
        </>
      )}
    </div>
  )
}
