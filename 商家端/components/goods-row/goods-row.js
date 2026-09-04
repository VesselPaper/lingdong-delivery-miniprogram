// 组件库 · 商品行（图 + 名称 + ¥价格 + x数量，一行一个完整展示）
// 统一「固定尺寸图盒 + 内部 image 100% 铺满」写法，杜绝图片拉伸。
// props: image, name, price, qty
Component({
  properties: {
    image: { type: String, value: '' },
    name: { type: String, value: '' },
    price: { type: null, value: '' },
    qty: { type: null, value: '' }
  }
})
