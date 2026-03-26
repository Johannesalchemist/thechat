function CameraController({ activeDoor, phase, setPhase }) {

  const progress = useRef(0)

  useFrame(({ camera }) => {

    // --- Kamerafahrt ---
    if (activeDoor !== null && phase === "OPENING") {

      const targetZ = 5.5   // doppelt so weit wie vorher
      camera.position.z = THREE.MathUtils.lerp(
        camera.position.z,
        targetZ,
        0.04
      )

      if (Math.abs(camera.position.z - targetZ) < 0.05) {
        setPhase("LIGHT")
      }
    }

    // --- Lichtmoment ---
    if (phase === "LIGHT") {
      progress.current += 0.02

      if (progress.current > 1.2) {
        setPhase("INSIDE")
      }
    }

  })

  return null
}
