
  // ---------- 配送数据页：卡片渲染（批次卡包裹订单子卡 / 订单卡 / 任务卡） ----------
  // 取代原先的表格 + 多选批量体系：
  //   · 整卡点击 → 打开详情抽屉（时间线 + 实时位置 + 商品明细）
  //   · 右键 → 复制编号 / 在地图查看 / 破坏性操作（唯一入口）
  //   · 活跃 / 历史 / 全部 分段 + 状态筛选 + 搜索 在渲染前统一过滤

  function renderDataPage() {
    if (!state) return
    var count = 0
    if (dataTab === 'order') count = renderOrderCards()
    else if (dataTab === 'task') count = renderTaskCards()
    else count = renderBatchCards()
    var box = $('dataCount')
    if (box) box.textContent = count ? ('共 ' + count + ' 张卡') : ''
  }

  // ---------- 过滤 ----------
  // 分段口径：活跃 / 历史 / 全部（与后端 admin 域 active/history 的判定一致）
  function inScope(kind, row) {
    if (dataScope === 'all') return true
    if (kind === 'batch') {
      var isActive = [0, 1, 2].indexOf(Number(row.status)) >= 0
      return dataScope === 'active' ? isActive : !isActive
    }
    if (kind === 'order') {
      var oActive = [2, 3, 6].indexOf(Number(row.status)) >= 0
      return dataScope === 'active' ? oActive : !oActive
    }
    var tActive = !row.void_at && Number(row.task_status) < 80
    return dataScope === 'active' ? tActive : !tActive
  }
  function inStatus(status) {
    if (statusFilter === '') return true
    return String(status) === statusFilter
  }
  function hit(q, vals) {
    if (!q) return true
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] !== undefined && vals[i] !== null && String(vals[i]).toLowerCase().indexOf(q) >= 0) return true
    }
    return false
  }
  function goodsNames(o) {
    return (o.items || []).map(function (it) { return it.goods_name }).filter(Boolean)
  }

  // ---------- 订单：商品明细行（最多 6 行，其余折叠成一行） ----------
  function orderGoodsRows(o, limit) {
    var items = o.items || []
    if (!items.length) return '<div class="o-row"><span class="o-name mini">（无商品明细）</span></div>'
    var max = limit || 6
    var rows = items.slice(0, max).map(function (it) {
      var img = it.goods_image
        ? '<img class="o-thumb" src="' + esc(it.goods_image) + '" alt="" onerror="this.style.display=\'none\'">'
        : '<span class="o-thumb ph"></span>'
      return '<div class="o-row">' + img
        + '<span class="o-name">' + esc(it.goods_name) + '</span>'
        + '<span class="o-qty">× ' + Number(it.quantity || 0) + '</span>'
        + '<span class="o-price">¥' + Number(it.price || 0).toFixed(2) + '</span></div>'
    }).join('')
    if (items.length > max) rows += '<div class="o-row"><span class="o-name mini">等 ' + items.length + ' 项商品</span></div>'
    return rows
  }

  // ---------- 批次卡（内含订单子卡） ----------
  function batchCardHtml(b, ordersOfBatch) {
    var lines = []
    if (b.device_sn) lines.push('<div class="bcard-line"><span class="k">机器人</span><span class="v mono">' + esc(b.device_sn) + '</span></div>')
    if (Number(b.total_items)) lines.push('<div class="bcard-line"><span class="k">件数</span><span class="v">' + Number(b.total_items) + ' 件</span></div>')
    var rt = batchRouteText(b)
    if (rt) lines.push('<div class="bcard-line"><span class="k">路线</span><span class="v">' + esc(rt) + '</span></div>')
    if (Number(b.status) === 2) {
      lines.push('<div class="bcard-line"><span class="k">当前停靠</span><span class="v">' + esc(currentStopText(b)) + '</span></div>')
      lines.push('<div class="bcard-line"><span class="k">进度</span><span class="v">已取 ' + Number(b.picked_orders || 0) + ' / ' + Number(b.total_orders || 0) + ' 单</span></div>')
    }
    lines.push('<div class="bcard-line"><span class="k">创建</span><span class="v weak">' + esc(b.created_at || '—') + '</span></div>')
    lines.push('<div class="bcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(b.last_event) + '</span></div>')

    var subs = ordersOfBatch.map(function (o) { return orderSubCardHtml(o) }).join('')
    var subWrap = ordersOfBatch.length
      ? '<div class="bcard-orders">' + subs + '</div>'
      : '<div class="bcard-more">该批次暂无可展示的订单明细</div>'

    return '<div class="bcard" data-kind="batch" data-id="' + b.id + '" tabindex="0"'
      + ' oncontextmenu="window.ctxBatch(' + b.id + ',event)" onclick="openDrawer(\'batch\',' + b.id + ')"'
      + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'batch\',' + b.id + ')">'
      + '<div class="bcard-head" style="--bh:' + batchHeadColor(b) + '">'
      + '<div class="bcard-title"><b>批次 ' + esc(b.code_short || b.daily_seq || b.id) + '</b>'
      + '<span class="full">' + esc(b.batch_no || '') + '</span></div>'
      + '<div class="bcard-tags">'
      + '<span class="tag solid">' + esc(b.status_text || BATCH_STATUS[Number(b.status)] || '') + '</span>'
      + '<span class="tag">' + Number(b.total_orders || 0) + ' 单</span>'
      + '</div></div>'
      + '<div class="bcard-body">' + lines.join('') + subWrap
      + '<div class="bcard-more">点击卡片查看详情与状态时间线 · 右键打开操作菜单</div>'
      + '</div></div>'
  }

  function orderSubCardHtml(o) {
    return '<div class="bcard-order" data-kind="order" data-id="' + o.id + '"'
      + ' oncontextmenu="window.ctxOrder(' + o.id + ',event)"'
      + ' onclick="event.stopPropagation();openDrawer(\'order\',' + o.id + ')">'
      + '<div class="bcard-order-head"><b>订单 ' + esc(o.code_short || o.daily_seq || o.id) + '</b>'
      + '<span class="lm">' + esc(o.landmark_name || '未选点位') + '</span>'
      + '<span class="st">' + orderTag(o) + '</span></div>'
      + '<div class="bcard-order-body">' + orderGoodsRows(o, 4) + '</div>'
      + '<div class="bcard-order-foot">'
      + '<span>取餐码 <b>' + esc(o.pickup_code || '—') + '</b></span>'
      + '<span>金额 <b>¥' + Number(o.total_amount || 0).toFixed(2) + '</b></span>'
      + '</div></div>'
  }

  function renderBatchCards() {
    var box = $('dataPanelBatch')
    if (!box) return 0
    var q = searchQ
    var all = state.batches || []
    var orders = state.orders || []
    var byBatch = {}
    orders.forEach(function (o) { if (o.batch_id) (byBatch[o.batch_id] = byBatch[o.batch_id] || []).push(o) })

    var rows = all.filter(function (b) {
      if (!inScope('batch', b)) return false
      if (!inStatus(b.status)) return false
      var mine = byBatch[b.id] || []
      var vals = [b.batch_no, b.code_short, b.daily_seq, b.device_sn, batchRouteText(b)]
      mine.forEach(function (o) { vals.push(o.order_no, o.code_short, o.landmark_name); vals = vals.concat(goodsNames(o)) })
      return hit(q, vals)
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>'
        + (q || statusFilter ? '没有符合条件的批次' : (dataScope === 'history' ? '暂无历史批次' : dataScope === 'all' ? '暂无批次' : '暂无活跃批次'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (b) { return batchCardHtml(b, byBatch[b.id] || []) }).join('') + '</div>'
    return rows.length
  }

  // ---------- 订单卡（扁平列表） ----------
  function renderOrderCards() {
    var box = $('dataPanelOrder')
    if (!box) return 0
    var q = searchQ
    var batchNo = {}
    ;(state.batches || []).forEach(function (b) { batchNo[b.id] = b.batch_no })

    var rows = (state.orders || []).filter(function (o) {
      if (!inScope('order', o)) return false
      if (!inStatus(o.status)) return false
      var vals = [o.order_no, o.code_short, o.daily_seq, o.landmark_name, o.pickup_code, o.device_sn, batchNo[o.batch_id]]
      vals = vals.concat(goodsNames(o))
      return hit(q, vals)
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-box"/></svg>'
        + (q || statusFilter ? '没有符合条件的订单' : (dataScope === 'history' ? '暂无历史订单' : dataScope === 'all' ? '暂无订单' : '暂无活跃订单'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (o) {
      return '<div class="bcard" data-kind="order" data-id="' + o.id + '" tabindex="0"'
        + ' oncontextmenu="window.ctxOrder(' + o.id + ',event)" onclick="openDrawer(\'order\',' + o.id + ')"'
        + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'order\',' + o.id + ')">'
        + '<div class="bcard-head" style="--bh:var(--ink-3)">'
        + '<div class="bcard-title"><b>订单 ' + esc(o.code_short || o.daily_seq || o.id) + '</b>'
        + '<span class="full">' + esc(o.order_no || '') + '</span></div>'
        + '<div class="bcard-tags"><span class="tag solid">' + esc(ORDER_STATUS[Number(o.status)] || ('状态 ' + o.status)) + '</span></div>'
        + '</div>'
        + '<div class="bcard-body">'
        + '<div class="bcard-line"><span class="k">送达点位</span><span class="v">' + esc(o.landmark_name || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">批次</span><span class="v mono">' + esc(batchNo[o.batch_id] || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">机器人</span><span class="v mono">' + esc(o.device_sn || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">取餐码</span><span class="v">' + esc(o.pickup_code || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">金额</span><span class="v">¥' + Number(o.total_amount || 0).toFixed(2) + '</span></div>'
        + '<div class="bcard-line"><span class="k">创建</span><span class="v weak">' + esc(o.created_at || '—') + '</span></div>'
        + '<div class="bcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(o.last_event) + '</span></div>'
        + '<div class="bcard-orders"><div class="bcard-order" style="cursor:default">'
        + '<div class="bcard-order-head"><b>商品明细</b><span class="st mini">' + (o.item_count || 0) + ' 件</span></div>'
        + '<div class="bcard-order-body">' + orderGoodsRows(o, 8) + '</div>'
        + '</div></div>'
        + '<div class="bcard-more">点击卡片查看详情与状态时间线 · 右键打开操作菜单</div>'
        + '</div></div>'
    }).join('') + '</div>'
    return rows.length
  }

  // ---------- 任务卡（扁平列表） ----------
  function renderTaskCards() {
    var box = $('dataPanelTask')
    if (!box) return 0
    var q = searchQ
    var orderNo = {}
    ;(state.orders || []).forEach(function (o) { orderNo[o.id] = o.order_no })
    var batchNo = {}
    ;(state.batches || []).forEach(function (b) { batchNo[b.id] = b.batch_no })

    var rows = (state.tasks || []).filter(function (t) {
      if (!inScope('task', t)) return false
      if (!inStatus(t.task_status)) return false
      return hit(q, [t.id, t.platform_task_id, t.device_sn, orderNo[t.order_id], batchNo[t.batch_id]])
    })

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><svg><use href="#i-truck"/></svg>'
        + (q || statusFilter ? '没有符合条件的任务' : (dataScope === 'history' ? '暂无历史任务' : dataScope === 'all' ? '暂无配送任务' : '暂无活跃任务'))
        + '</div>'
      return 0
    }
    box.innerHTML = '<div class="cards">' + rows.map(function (t) {
      var voided = !!t.void_at
      return '<div class="tcard" data-kind="task" data-id="' + t.id + '" tabindex="0"'
        + ' oncontextmenu="window.ctxTask(' + t.id + ',event)" onclick="openDrawer(\'task\',' + t.id + ')"'
        + ' onkeydown="if(event.key===\'Enter\')openDrawer(\'task\',' + t.id + ')">'
        + '<div class="tcard-head"><b>任务 #' + t.id + '</b>'
        + '<span class="st">' + taskTag(t) + '</span></div>'
        + '<div class="tcard-line"><span class="k">订单</span><span class="v mono">' + esc(orderNo[t.order_id] || (t.order_id ? '#' + t.order_id : '—')) + '</span></div>'
        + '<div class="tcard-line"><span class="k">批次</span><span class="v mono">' + esc(batchNo[t.batch_id] || (t.batch_id ? '#' + t.batch_id : '—')) + '</span></div>'
        + '<div class="tcard-line"><span class="k">平台任务</span><span class="v mono">' + esc(t.platform_task_id || '—') + '</span></div>'
        + '<div class="tcard-line"><span class="k">设备</span><span class="v mono">' + esc(t.device_sn || '—') + '</span></div>'
        + '<div class="tcard-line"><span class="k">最近变更</span><span class="v weak">' + lastEventText(t.last_event) + '</span></div>'
        + (voided ? '<div class="tcard-line"><span class="k">作废于</span><span class="v weak">' + esc(t.void_at) + '</span></div>' : '')
        + '</div>'
    }).join('') + '</div>'
    return rows.length
  }
