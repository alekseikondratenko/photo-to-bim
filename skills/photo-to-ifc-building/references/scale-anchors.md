# Choosing scale evidence

One photograph alone usually leaves absolute scale unresolved. Prefer a supplied
measurement tied to two clearly identified pixels on the same physical feature.
`calibrate_camera` currently accepts a **vertical** height anchor; its bottom
and top must correspond to that height, not unrelated window heads.

When no measurement exists, state a plausible assumed height and its source.
For example, a 2.1 m door estimate is an assumption about that particular door,
not a universal standard. Avoid a falsely precise value taken from another
building, region or construction convention. A second independent anchor can
reveal inconsistency, but two matching assumptions do not make a survey.

Record `height_m`, `bottom`, `top`, `status` (`assumed` or `measured`), `source`
and optional `uncertainty_m`. Keep observed pixels distinct from the assumed
metric dimension in `reconstruction.json` and the IFC evidence property set.
If scale changes, update all dependent geometry consistently.

Check eave and floor interpretation before inferring storey height. Upper
windows can belong to a gable or dormer, not a full-height upper storey.
An unusual footprint or camera elevation is a reason to inspect assumptions,
not proof that the real building cannot have that size. Derive a horizon from
parallel directions where possible; a tree line is not necessarily a horizon.

For a simple uncertainty check, repeat the reconstruction measurements at the
low and high plausible anchor heights while keeping camera and planes fixed.
Report that range as conditional scale sensitivity. Camera, lens and plane
uncertainty require separate assessment.
