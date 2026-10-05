/* global __FOLIATE_SUFFIX__ */
// Octavo patch: custom-element names carry a per-build suffix so a plugin
// update can register fresh classes, and re-enabling the same build is a no-op.
const suffix = typeof __FOLIATE_SUFFIX__ === 'string' ? __FOLIATE_SUFFIX__ : ''
export const tag = name => `${name}${suffix}`
export const define = (name, cls) => {
    const t = tag(name)
    if (!customElements.get(t)) customElements.define(t, cls)
}
