import DefaultTheme from 'vitepress/theme'
import './custom.css'
import HomeHighlights from './components/HomeHighlights.vue'
import VersionBadge from './components/VersionBadge.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeHighlights', HomeHighlights)
    app.component('VersionBadge', VersionBadge)
  }
}
