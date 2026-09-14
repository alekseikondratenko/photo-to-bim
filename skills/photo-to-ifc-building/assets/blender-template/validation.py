"""Combine evidence without turning visual acceptance into an automated pass."""
VERSION = "0.8.4"

def combine(ifc, photographic, appearance, visual_review=None):
    review = visual_review or {"decision": "not_reviewed"}
    if review.get("decision") not in ("accepted", "rejected", "not_reviewed"):
        raise ValueError("Visual decision must be accepted, rejected or not_reviewed")
    if review["decision"] != "not_reviewed":
        if review.get("source") not in ("user", "agent") or not review.get("reviewer") or not review.get("basis"):
            raise ValueError("Visual review needs source (user/agent), reviewer and basis")
    checks = {"ifc": ifc.get("verdict", "INCOMPLETE"),
              "photographic": photographic.get("status", "INCOMPLETE"),
              "appearance": appearance.get("status", "INCOMPLETE")}
    deviations = [name for name, status in checks.items() if status != "PASS"]
    if checks["ifc"] != "PASS":
        acceptance = "blocked"
    elif review["decision"] == "rejected":
        acceptance = "rejected"
    elif review["decision"] == "accepted" and review.get("source") == "user":
        acceptance = "accepted_with_deviations" if deviations else "accepted"
    else:
        acceptance = "pending_user_review"
    return {"schema_version": 1, "version": VERSION, "ifc": ifc,
            "photographic": photographic, "appearance": appearance,
            "visual_review": review, "acceptance": {"status": acceptance, "deviations": deviations},
            "note": "Visual acceptance never changes an automated check. Agent visual review is not user acceptance."}
