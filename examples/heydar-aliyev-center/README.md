# Heydar Aliyev Center

Codex reconstruction, plugin **0.8.0**. This example shows how the method can
represent flowing roof shells, curved openings and curtain-wall assemblies as
semantic IFC. It is an approximation from one photograph, not the architect's BIM.

| Reference photograph | Codex reconstruction |
| --- | --- |
| ![Reference photograph by Iwan Baan](reference.jpg) | ![Codex reconstruction with curved roof shells](comparison.png) |

[Download IFC](house.ifc) · [Assumptions and camera](reconstruction.json) ·
[Recorded validation](validation.json) · [Publication metadata](example.json)

The photograph is shown to compare the reconstruction's curved roof, arch and
facade against its input. The principal crests and arch are recognisable, while
the model simplifies panel spacing, reflections and the narrow right-hand return.
The visible roof contours guide a lofted exterior with assumed depth. Rear
enclosure, scale and floor heights are inferred; this run uses one exterior-envelope
storey rather than claiming a recovered internal floor layout. Roof panel joints,
glass reflections and facade rhythm are simplified.

## Recorded evidence

- IFC schema, geometry and semantics: **PASS** in the original report.
- Nine fitted contour landmarks passed the retained 5 px tolerance.
- No held-out landmarks or silhouette mask were used. Fitted contour agreement
  does not establish independent accuracy of the curved surfaces or hidden depth.

The final render and IFC are unchanged. Supporting files preserve the original
assumptions and checks; these are not newly evaluated results.

## Reference

Architecture: Zaha Hadid Architects. Reference photograph: **© Iwan Baan**, via
[ArchDaily](https://www.archdaily.com/448774/heydar-aliyev-center-zaha-hadid-architects).
[Photographer's project page](https://iwan.com/portfolio/heydar-aliyev-centre-baku-azerbaijan/).
The original photograph is displayed for comparison with the generated IFC render;
its copyright remains with the rights holder. It is **not** covered by the
repository's Apache-2.0 software licence. No open licence or separate permission
to redistribute this photograph has been verified; attribution is not a licence.
