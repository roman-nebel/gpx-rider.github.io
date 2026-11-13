// Updates the label and appearance of a toolbar gallery button.
export function setPickerSelection(picker, name) {
  const label = name || `Select ${picker.dataset.label.toLowerCase()}`;
  picker.classList.toggle("btn-blue", !name);
  picker.classList.toggle("btn-ghost", Boolean(name));
  picker.querySelector(".selection-picker-name").textContent = label;
  picker.title = name || "";
  picker.setAttribute("aria-label", name ? `${picker.dataset.label}: ${name}` : label);
}
