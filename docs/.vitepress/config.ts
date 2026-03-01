import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'context-optimizer',
  description: 'Observes session behavior and proposes evidence-based context improvements for CLAUDE.md, Skills, and slash commands',
  base: '/context-evalver/',

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Usage', link: '/usage/context-audit' },
      { text: 'Reference', link: '/configuration' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Daily Workflow', link: '/daily-workflow' },
        ],
      },
      {
        text: 'Skills',
        items: [
          { text: '/context-audit', link: '/usage/context-audit' },
          { text: '/context-draft', link: '/usage/context-draft' },
          { text: '/context-apply', link: '/usage/context-apply' },
          { text: '/context-status', link: '/usage/context-status' },
          { text: '/context-reset', link: '/usage/context-reset' },
          { text: '/context-config', link: '/usage/context-config' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/configuration' },
          { text: 'Deployment', link: '/deployment' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hiromaily/context-evalver' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
