import * as THREE from "three"
import { Canvas, useFrame } from "@react-three/fiber"
import { useEffect, useRef, useState } from "react"

const COLORS = ["#ff0000","#ff7a00","#ffd400","#00bfff","#8a2be2"]

const RADIUS = 9
const DOOR_WIDTH = 2.5
const DOOR_HEIGHT = 4
const FRAME_THICKNESS = 0.5

// -----------------------------
// SYMBOLS (Gold)
// -----------------------------

function Symbol({ index }) {
  return (
    <mesh position={[0, DOOR_HEIGHT + 1, 0]}>
      <torusGeometry args={[0.6, 0.15, 16, 32]} />
      <meshStandardMaterial
        color="#FFD700"
        emissive="#FFD700"
        emissiveIntensity={1.2}
        metalness={1}
        roughness={0.1}
      />
    </mesh>
  )
}

// -----------------------------
// PORTAL
// -----------------------------

function Portal({ index, activeDoor, setActiveDoor, phase }) {

  const groupRef = useRef()
  const doorRef = useRef()
  const lightRef = useRef()

  const angle = (index - 2) * (Math.PI / 6)

  const x = Math.sin(angle) * RADIUS
  const z = -Math.cos(angle) * RADIUS

  const isActive = activeDoor === index

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.lookAt(0, DOOR_HEIGHT / 2, 0)
    }
  }, [])

  useFrame(() => {

    if (doorRef.current) {
      const target = isActive ? -Math.PI / 2 : 0
      doorRef.current.rotation.y += (target - doorRef.current.rotation.y) * 0.05
    }

    if (lightRef.current) {
      const target = isActive ? 3 : 0
      lightRef.current.intensity += (target - lightRef.current.intensity) * 0.05
    }
  })

  return (
    <group ref={groupRef} position={[x, DOOR_HEIGHT / 2, z]}>

      {/* Sandstein Mauer */}
      <mesh position={[0, 0, -0.3]}>
        <boxGeometry args={[DOOR_WIDTH + 2, DOOR_HEIGHT + 2, 0.8]} />
        <meshStandardMaterial color="#d2b48c" roughness={1} />
      </mesh>

      {/* Regenbogen Rahmen */}
      <mesh>
        <boxGeometry args={[DOOR_WIDTH + FRAME_THICKNESS * 2, DOOR_HEIGHT + FRAME_THICKNESS * 2, 0.3]} />
        <meshStandardMaterial color={COLORS[index]} metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Tür */}
      <group ref={doorRef} position={[-DOOR_WIDTH / 2, 0, 0.2]}>
        <mesh
          position={[DOOR_WIDTH / 2, 0, 0]}
          onClick={() => {
            if (activeDoor === null) {
              setActiveDoor(index)
            }
          }}
        >
          <boxGeometry args={[DOOR_WIDTH, DOOR_HEIGHT, 0.15]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      </group>

      <pointLight
        ref={lightRef}
        position={[0, 0, -1]}
        color="#ffd8a0"
        distance={6}
      />

      <Symbol index={index} />

    </group>
  )
}

// -----------------------------
// CAMERA CONTROLLER
// -----------------------------

function CameraController({ activeDoor, phase, setPhase }) {

  useFrame(({ camera }) => {

    if (activeDoor !== null && phase === "OPENING") {

      camera.position.z -= 0.05

      if (camera.position.z <= 10) {
        setPhase("INSIDE")
      }
    }
  })

  return null
}

// -----------------------------
// INSIDE ROOM
// -----------------------------

function InsideRoom({ activeDoor }) {

  return (
    <>
      <mesh position={[0, 2, -12]}>
        <planeGeometry args={[8, 4.5]} />
        <meshBasicMaterial>
          <videoTexture attach="map" args={[document.createElement("video")]} />
        </meshBasicMaterial>
      </mesh>
    </>
  )
}

// -----------------------------
// MAIN
// -----------------------------

export default function Room3D() {

  const [activeDoor, setActiveDoor] = useState(null)
  const [phase, setPhase] = useState("LOBBY")

  useEffect(() => {
    if (activeDoor !== null) {
      setPhase("OPENING")
    }
  }, [activeDoor])

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Canvas camera={{ position: [0, 5, 14], fov: 45 }}>

        <CameraController activeDoor={activeDoor} phase={phase} setPhase={setPhase} />

        {/* Rotunde */}
        <mesh position={[0, 4, 0]}>
          <cylinderGeometry args={[14, 14, 8, 64]} />
          <meshStandardMaterial color="#f4efe6" side={THREE.BackSide} />
        </mesh>

        {Array.from({ length: 5 }).map((_, i) => (
          <Portal
            key={i}
            index={i}
            activeDoor={activeDoor}
            setActiveDoor={setActiveDoor}
            phase={phase}
          />
        ))}

        {phase === "INSIDE" && (
          <InsideRoom activeDoor={activeDoor} />
        )}

        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 5]} intensity={1.2} />

      </Canvas>

      {phase === "INSIDE" && (
        <div style={{
          position: "absolute",
          bottom: "40px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "600px",
          background: "rgba(255,255,255,0.9)",
          padding: "20px",
          borderRadius: "12px"
        }}>
          <input
            placeholder="Schreibe hier..."
            style={{ width: "100%", padding: "10px" }}
          />
        </div>
      )}

    </div>
  )
}
