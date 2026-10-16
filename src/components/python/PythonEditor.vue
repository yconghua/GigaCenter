<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { python } from '@codemirror/lang-python'

// CodeMirror 6 Python 编辑器：语法高亮、括号匹配、行号、撤销历史、查找替换、自动补全。
// 快捷键：Ctrl+Enter 运行全部、Ctrl+Shift+Enter 运行选中、Ctrl+Shift+F 格式化（事件上抛由页面处理）。

const props = defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'run', value: string): void
  (e: 'run-selection', value: string): void
  (e: 'format', value: string): void
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

onMounted(() => {
  if (!host.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      indentOnInput(),
      indentUnit.of('    '),
      history(),
      python(),
      autocompletion(),
      highlightSelectionMatches(),
      keymap.of([
        {
          key: 'Ctrl-Enter',
          run: () => {
            emit('run', props.modelValue)
            return true
          }
        },
        {
          key: 'Ctrl-Shift-Enter',
          run: () => {
            const sel = view?.state.sliceDoc(view?.state.selection.main.from, view?.state.selection.main.to)
            emit('run-selection', sel || props.modelValue)
            return true
          }
        },
        {
          key: 'Ctrl-Shift-f',
          run: () => {
            emit('format', props.modelValue)
            return true
          }
        },
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString())
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--c-surface)', color: 'var(--c-text)' },
        '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace' },
        '.cm-gutters': { backgroundColor: 'var(--c-bg)', color: 'var(--c-text-3)', borderRight: '1px solid var(--c-border)' },
        '.cm-activeLine': { backgroundColor: 'var(--c-bg)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--c-bg)', color: 'var(--c-text-2)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: 'var(--c-primary-soft)'
        }
      })
    ]
  })
  view = new EditorView({ state, parent: host.value })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// 外部 modelValue 变化时整体替换文档（编辑器内部修改会反向 emit，故先比对避免光标跳动）
watch(
  () => props.modelValue,
  (v) => {
    if (view && view.state.doc.toString() !== v) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
    }
  }
)

defineExpose({ focus: () => view?.focus() })
</script>

<template>
  <div ref="host" class="h-full w-full overflow-hidden rounded-md border border-[var(--c-border-strong)] bg-[var(--c-surface)]" />
</template>
