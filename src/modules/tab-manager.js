/**
 * Tab navigation manager — wires up nav buttons and dispatches
 * render calls to feature modules.
 */

export function createTabManager(state, features) {
  function switchTab(tabName) {
    state.set('activeTab', tabName)

    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'))

    const tabBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`)
    const tabContent = document.getElementById(`${tabName}-tab`)
    if (tabBtn) tabBtn.classList.add('active')
    if (tabContent) tabContent.classList.add('active')

    // Dispatch to feature module
    const feature = features[tabName]
    if (feature?.render) feature.render()
  }

  function hideAllViewModeSections() {
    document.querySelectorAll('.view-mode-section').forEach(section => section.classList.add('hidden'))
  }

  function setupEventListeners() {
    document.querySelectorAll('.nav-btn').forEach(button => {
      button.addEventListener('click', async (e) => {
        const tab = e.currentTarget.dataset.tab
        if (tab) switchTab(tab)
      })
    })
  }

  return { switchTab, hideAllViewModeSections, setupEventListeners }
}
