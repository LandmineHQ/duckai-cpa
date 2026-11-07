import { defineConfig } from 'vitepress'

// GitHub Pages project site: https://landminehq.github.io/duckai-cpa/
// Override with DOCS_BASE=/ when deploying at a custom domain.
const base = (process.env.DOCS_BASE || '/duckai-cpa/').replace(/\/?$/, '/')

export default defineConfig({
  lang: 'zh-CN',
  title: 'DuckAI CPA',
  titleTemplate: ':title · DuckAI CPA',
  description: '把 duck.ai 封装成 OpenAI 兼容 API 的自托管网关 —— 多身份池、订阅、工具调用、图片与 PDF 上下文。',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#f97316' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'DuckAI CPA' }],
    ['meta', { property: 'og:description', content: 'OpenAI 兼容的 duck.ai 自托管网关与 React 管理控制台。' }],
    ['meta', { property: 'og:image', content: `${base}assets/admin-overview.jpg` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }]
  ],
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    lineNumbers: true
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'DuckAI CPA',
    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/introduction', activeMatch: '^/guide/' },
      { text: 'API', link: '/api/overview', activeMatch: '^/api/' },
      { text: '参考', link: '/reference/configuration', activeMatch: '^/reference/' },
      {
        text: 'GitHub',
        link: 'https://github.com/LandmineHQ/duckai-cpa'
      }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '项目介绍', link: '/guide/introduction' },
            { text: '快速开始', link: '/guide/quickstart' },
            { text: '安装与部署', link: '/guide/installation' }
          ]
        },
        {
          text: '使用',
          items: [
            { text: '管理控制台', link: '/guide/admin-console' },
            { text: '功能说明', link: '/guide/features' },
            { text: '订阅与身份', link: '/guide/subscriptions' },
            { text: '常见问题', link: '/guide/faq' }
          ]
        }
      ],
      '/api/': [
        {
          text: 'API 文档',
          items: [
            { text: '概览', link: '/api/overview' },
            { text: '认证与请求约定', link: '/api/authentication' },
            { text: 'Chat Completions', link: '/api/chat-completions' },
            { text: 'Responses', link: '/api/responses' },
            { text: 'Models', link: '/api/models' },
            { text: 'Images', link: '/api/images' },
            { text: 'Compact', link: '/api/compact' },
            { text: '管理 API', link: '/api/admin' },
            { text: '错误码', link: '/api/errors' }
          ]
        }
      ],
      '/reference/': [
        {
          text: '参考',
          items: [
            { text: '配置项', link: '/reference/configuration' },
            { text: '架构与请求流', link: '/reference/architecture' },
            { text: '数据与安全', link: '/reference/security' },
            { text: '文档站部署', link: '/reference/docs-site' }
          ]
        }
      ]
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除搜索',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    lastUpdatedText: '最后更新',
    footer: {
      message: '仅供个人学习与私有部署；请遵守 duck.ai 的服务条款。',
      copyright: 'MIT Licensed · DuckAI CPA'
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/LandmineHQ/duckai-cpa' }],
    editLink: {
      pattern: 'https://github.com/LandmineHQ/duckai-cpa/edit/main/docs-site/:path',
      text: '在 GitHub 上编辑此页'
    }
  }
})
