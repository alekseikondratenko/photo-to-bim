# Roof geometry cookbook — read before fighting a pitched roof

Every fact here was re-derived from pixels, at a cost of 15–20 minutes each, by at
least two independent runs. Reading this page is how you don't pay again.

## The vocabulary (German house forms travel well)

- **Satteldach** — plain gable roof: one ridge, two planes, two gable-end walls.
- **Zwerchgiebel / Zwerchhaus** — a wall dormer: a gable rising FROM THE FACADE
  PLANE, its ridge perpendicular to the main ridge, cutting into the main roof.
- **Wangen** — the small side cheeks closing a Zwerchgiebel's flanks down to the
  main roof surface.
- **Krüppelwalm** — half-hip: the gable's top is clipped by a small sloped plane.
- **Catslide** — one main roof plane extended further down than the other,
  usually over a single-storey section.

## Flush vs projecting — THE test, before anything else

A cross-gable is either **flush** (its face IS the facade plane) or **projecting**
(its face stands in front, on its own walls). They need different geometry, and at
10–20° of yaw they look identical at a glance. Two runs burned cycles flip-flopping.

- **Flush** ⇒ the valleys run from the main roof down to the FACADE EAVE LINE at
  the wing's edges. Check: does the valley's lower end land on the eave at the
  wing's edge x-position? One pixel check settles it.
- **Projecting** ⇒ you must see a RETURN FACE (a strip of wall facing sideways at
  the wing's edge) or its shadow. No return face visible from your viewing side is
  NOT proof of flush — check which way the step would face before concluding.
- The wing's ridge may be LOWER than the main ridge (common) — then the two ridge
  silhouettes CROSS in the image: the wing's ridge, being closer, rises above the
  main ridge as it approaches the camera. A silhouette local-minimum where they
  meet is what this crossing looks like. Do not force a same-height T-junction.

## Valleys, mechanically

For equal pitches, the valley runs at 45° IN PLAN between the two roof planes.
Its image line goes from where the wing's roof meets the main roof (top) to the
eave (bottom, flush case). The valley is geometry you can predict and then CHECK
against one traced pixel line — predict first, look second.

## Rakes, verges, and the 10 px that will gaslight you

- The **barge board / verge** overhangs the gable wall by 0.2–0.4 m. The rake line
  you trace against the sky is the BOARD's edge; the wall's rake is inset behind
  it. Expect a ~5–15 px offset between "silhouette rake" and "wall rake" —
  it is overhang, not a measurement error. One run chased this for ten minutes.
- The apex of the WALL triangle sits slightly off the apex of the SILHOUETTE for
  the same reason.
- The eave you trace may be the GUTTER (projecting, slightly lower and forward)
  or the WALL TOP (behind the soffit, hidden above the soffit's shadow line).
  They differ by the overhang; decide which you traced before unprojecting it.

## Pitch facts

- A gable's two rakes converge to vanishing points that sit on the VERTICAL LINE
  through the gable-face direction's horizon VP, symmetric about the horizon.
  This gives pitch from two traced rakes without any metric scale:
  `tan(pitch) = |vp_rake_y − horizon_y| / sqrt((vp_face_x − cx)² + f²)`.
- The wing's pitch is OFTEN NOT the main pitch (measured case: main 44°, wing 37°).
  Never assume one pitch for all planes; measure each family of rakes.
- A rake angle measured on a FORESHORTENED gable face reads far steeper than the
  true pitch (a 45° roof read 73° before correction). Only trust pitch computed
  through the vanishing-point relation above, or measured on a face you have
  already solved the yaw for.

## The stepped-eave family of surprises

If the traced eave is NOT one straight line (two segments at different heights or
slopes), the candidates are, in rough order of prior probability:
1. a catslide / lower single-storey section under the same plane,
2. a projecting or recessed section of the facade (step ⊥ to the camera hides
   its own return face),
3. two different roof planes meeting behind an occluder.
Test by unprojecting both segments to the SAME plane: consistent heights + a
0.3–0.6 m forward/down offset that matches the pitch direction = one continuous
plane with a stepped lower edge (case 1). Log the verdict in RECON.md's REFUTED
section — this exact question was re-litigated three times in one run.
