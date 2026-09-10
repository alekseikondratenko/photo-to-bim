# Scale anchors — turning ratios into metres without guessing twice

A photograph gives ratios; metres need an anchor. The wrong anchor poisons every
number downstream and announces itself only later as an absurdity (a 20 m-deep
house, a 4.2 m eye height, a 50 m terrace). This page is the anchor table plus
the checks that catch a bad one early. All values are common European residential
practice; state which you used in RECON.md's Assumed section.

## The anchor table

| Element | Typical value | Notes |
|---|---|---|
| Door leaf | 2.00–2.10 m | the single most reliable anchor when visible |
| Window head above floor | **2.135 m** | remarkably standard; heads align with door heads |
| Window sill (habitable room) | 0.85–1.00 m | kitchens/baths can sit higher |
| Storey height (floor-to-floor) | 2.75–2.90 m | ground floors sometimes 3.0+ |
| Eave height (Traufhöhe), 1.5-storey | **2.5–3.0 m** | knee-wall houses — see the storey test below |
| Eave height, full 2-storey | 5.2–5.8 m | |
| Garage door | 2.4 m wide (single), 2.0–2.1 m high | |
| Balustrade / guard rail | 0.9–1.1 m | |
| Terrace furniture seat height | 0.42–0.45 m | strongest scale cue near the camera |
| Car (for carports) | ~4.5 × 1.8 m | |
| Eye height, standing photographer | 1.5–1.7 m | archviz renders often use 1.6, or an elevated hero eye |

Prefer TWO anchors that agree before trusting either (a door and a window head;
a sill and a balustrade). One anchor is a guess with confidence.

## The storey test — run it BEFORE assuming eave height

Look at where the eave line passes relative to the upper windows:

- Eave ABOVE a full row of upper windows ⇒ genuine 2-storey ⇒ Traufhöhe ~5.5 m.
- Eave line passing THROUGH or just under the upper-window level, with those
  windows actually sitting in the gable/dormer faces ⇒ **1.5-storey knee-wall
  house** ⇒ Traufhöhe ~2.8 m.

One field run assumed 2-storey by default, derived a 20 × 20 m footprint and a
4.16 m eye, and spent ~10 minutes unwinding it. The eave-through-the-windows
observation was the unlock. Check it first; it costs one look.

## Sanity checks that catch a wrong anchor immediately

- **Eye height** should land 1.4–1.8 m (or match the declared hero-camera style).
  Outside that: the anchor or the horizon is wrong.
- **Footprint** for a detached house: 8–14 m per side. A 20 m side from a house
  photo means the anchor, not the house.
- **Distance vs ground features**: pick one ground point (terrace edge, path),
  compute its distance from the horizon relation, ask whether the photographer
  plausibly stood there.
- **Advertised area**: filenames and captions leak ground truth ("variant-45-130"
  = 45° pitch, ~130 m² living area). Use as a cross-check, not as the anchor.

## Horizon facts worth keeping loaded

- The horizon row cuts every standing vertical at THE CAMERA'S EYE HEIGHT —
  eye height as a fraction of any known vertical is free, no solve needed.
- Terrain is not the horizon: a visible tree line or hill sits above the true
  horizon; using it moves the eye up and everything else with it. Derive the
  horizon from the vanishing points (solve_camera reports it), not from scenery.
