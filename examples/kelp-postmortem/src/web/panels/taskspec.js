/**
 * TaskSpec panel — renders into evidence-rail section 03.
 */

import { setEvidencePill } from "../lib/diagram.js";
import { $ } from "../lib/state.js";

export function renderTaskSpecDrafting() {
  const body = $("#ev-taskspec");
  if (!body) return;
  body.innerHTML = "";
  const note = document.createElement("p");
  note.className = "ev-empty";
  note.textContent = "Client LLM authoring TaskSpec…";
  body.appendChild(note);
  setEvidencePill("taskspec", "drafting", "busy");
}

export function renderTaskSpec(decision) {
  const body = $("#ev-taskspec");
  if (!body) return;
  body.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "taskspec-grid";

  const rows = [
    ["title", decision?.title],
    ["objective", decision?.objective],
    ["delivery", decision?.deliveryType],
    ["domain", decision?.taskDomain],
    ["format", decision?.requiredFormat],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    const lab = document.createElement("span");
    lab.className = "taskspec-label";
    lab.textContent = k;
    const val = document.createElement("span");
    val.className = "taskspec-value";
    val.textContent = String(v);
    grid.appendChild(lab);
    grid.appendChild(val);
  }

  if (Array.isArray(decision?.acceptanceCriteria)) {
    const lab = document.createElement("span");
    lab.className = "taskspec-label";
    lab.textContent = "criteria";
    const list = document.createElement("ul");
    list.className = "taskspec-list";
    for (const item of decision.acceptanceCriteria) {
      const li = document.createElement("li");
      li.textContent = String(item);
      list.appendChild(li);
    }
    grid.appendChild(lab);
    grid.appendChild(list);
  }

  if (decision?.evaluationRubric) {
    const lab = document.createElement("span");
    lab.className = "taskspec-label";
    lab.textContent = "rubric";
    const val = document.createElement("span");
    val.className = "taskspec-value";
    val.textContent = decision.evaluationRubric;
    grid.appendChild(lab);
    grid.appendChild(val);
  }

  if (Array.isArray(decision?.forbiddenClaims) && decision.forbiddenClaims.length > 0) {
    const lab = document.createElement("span");
    lab.className = "taskspec-label";
    lab.textContent = "forbidden";
    const list = document.createElement("ul");
    list.className = "taskspec-list";
    for (const item of decision.forbiddenClaims) {
      const li = document.createElement("li");
      li.textContent = String(item);
      list.appendChild(li);
    }
    grid.appendChild(lab);
    grid.appendChild(list);
  }

  body.appendChild(grid);
  setEvidencePill("taskspec", "authored", "done");
}
