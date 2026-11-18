/**
 * 侧栏 `sidebar.panellist` 放一个入口，`main` 槽位用 iframe 挂出面板块。
 * 面板本体是 host 侧 `/dsh-memory/panel` 返回的 HTML —— 渲染逻辑不用写进 React，
 * 改面板不用重启。
 *
 * 经典 script，不是 ESM：window.__ModuleLoader__.load + factory(require)。
 * `id` 必须和 package.json 的 name 一致（`dsh-memory`），否则静默不加载。
 * 导出必须是带 apply 的对象。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    var PANEL = '/dsh-memory/panel'

    function Icon() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            fontSize: '15px',
            lineHeight: 1,
            userSelect: 'none',
          },
          title: '记忆中心：项目核心开关 / 统计 / 检索',
        },
        '🧠',
      )
    }

    function Panel() {
      return h('iframe', {
        src: PANEL,
        title: '记忆中心',
        style: {
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
          background: '#14161b',
        },
      })
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(e) {
        return { err: e }
      }
      componentDidCatch(e, info) {
        try {
          console.error('[dsh-memory]', e, info)
        } catch {}
      }
      render() {
        if (this.state.err) {
          var e = this.state.err
          return h(
            'div',
            {
              style: {
                padding: 20,
                color: '#ff9a9a',
                fontSize: 12.5,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
              },
            },
            '记忆面板出错：',
            String((e && e.message) || e),
          )
        }
        return this.props.children
      }
    }

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    exports.name = 'dsh-memory-client'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'dsh-memory',
            order: 22,
            label: function () {
              return '记忆'
            },
          },
          Icon,
        )
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'dsh-memory' }, function () {
          return h(Boundary, null, h(Panel, null))
        })
      })
    }

    return module.exports
  },
})
