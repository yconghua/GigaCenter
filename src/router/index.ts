import { createRouter, createWebHashHistory } from 'vue-router'
import Home from '@/pages/Home.vue'
import FormatConvert from '@/pages/convert/FormatConvert.vue'
import AnalyzeWorkbench from '@/pages/analyze/AnalyzeWorkbench.vue'
import Settings from '@/pages/Settings.vue'

// hash 路由：首页（介绍/使用流程）+ 格式转换 / 数据分析 独立导航页；任何未匹配路由跳回首页
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/home', component: Home },
    { path: '/convert', component: FormatConvert },
    { path: '/analyze', component: AnalyzeWorkbench },
    { path: '/settings', component: Settings },
    { path: '/:pathMatch(.*)*', redirect: '/home' }
  ]
})
