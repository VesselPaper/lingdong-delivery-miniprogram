
  // 2026-10-12 移除：本文件（配送数据页详情抽屉：状态时间线 + 实时位置）已从 build.js 装配清单摘除。
  // 管理员网页细分后只管机器人事务，订单/任务管理只在商家端进行（见《git交接文档23》）。
  // 后端 /admin/timeline 接口保留（供需要时恢复或外部使用）。
  //
  // 2026-10-14 合并说明：远端那条线**仍在用**抽屉（build.js 清单里也留着 07）。
  // 本次按本地口径（更新的一方：整页删除「配送数据」）保持移除。若日后要恢复抽屉，要同时做三件事：
  //   ① build.js 清单补回 'js/parts/admin/07-drawer.js'
  //   ② index.html 补回 #detailDrawer / #drawerTitle / #drawerBody 三个节点（本次取的是本地版，已无这些节点）
  //   ③ 06 片 logout() 里的 closeDrawer() 调用本次已删除（本地线删抽屉时漏删，会 ReferenceError），恢复时要加回
