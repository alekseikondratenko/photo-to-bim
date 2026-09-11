# Roof interpretation

Resolve topology before detailing. Identify visible ridges, eaves, rakes,
valleys and roof/wall junctions. Keep alternative interpretations in the
assumption ledger when the photograph does not distinguish them.

A cross-gable may be flush with the facade or project on its own walls. Look
for a return face, a valley endpoint and consistent depth cues. Absence of a
visible return face does not prove flush geometry; it can be occluded. A
cross-gable can also have a different ridge height or pitch from the main roof.

For a valley, intersect the two proposed roof planes in the model and compare
its projected line to the image. Avoid applying a fixed plan angle without
checking the two planes' orientation and pitch. Image-space rake slope alone
is not physical pitch under perspective.

Distinguish the outer verge, gutter and overhang silhouette from the wall edge.
Assign each traced feature to the surface it actually describes. `place_features`
uses an arbitrary plane in the same Z-up frame, so it can work on either a
facade or a roof plane without changing coordinate conventions. Projecting a
point onto an assumed plane does not establish that it belongs to that plane.

Use `profile_wall` for a gable face and `roof` for the actual roof-plane polygons.
Clip roof boundaries at intersections instead of overlapping complete gable
solids. Check the resulting roof in an oblique view as well as the comparison
camera: a single viewpoint can hide an incorrect junction. The current IFC
gate does not check all roof junctions or watertightness.
