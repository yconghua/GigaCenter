<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { AnalyzeImportPayload, ProbeFileResult } from '@shared/ipc-types'

/**
 * 导入前预览命名模态：展示结构探测结果，允许对每个表重命名表名、对每一列重命名列名。
 * 表名/列名冲突自动追加 _1/_2 并红色高亮；视图与 SQL dump 的列名不可改（只读展示）。
 * 确认后通过 onConfirm 回传完整映射（多文件多表一次提交）。
 */

const props = defineProps<{
  files: ProbeFileResult[]
  onConfirm: (files: AnalyzeImportPayload['files']) => void
  onClose: () => void
}>()

interface EditColumn {
  index: number
  sourceName: string
  name: string
  inferredType: string
  readOnly: boolean
  conflict: boolean
}

interface EditTable {
  fileIndex: number
  fileName: string
  filePath: string
  tableIndex: number
  sourceName: string
  tableName: string
  rowCount: number | null
  readOnlyColumns: boolean
  conflict: boolean
  columns: EditColumn[]
}

const edits = reactive<EditTable[]>([])

for (let fi = 0; fi < props.files.length; fi++) {
  const f = props.files[fi]
  for (const t of f.tables) {
    const readOnlyColumns = t.readOnlyColumns ?? false
    edits.push({
      fileIndex: fi,
      fileName: f.fileName,
      filePath: f.filePath,
      tableIndex: t.tableIndex,
      sourceName: t.sourceName,
      tableName: t.sourceName,
      rowCount: t.rowCount,
      readOnlyColumns,
      conflict: false,
      columns: t.columns.map((c) => ({
        index: c.index,
        sourceName: c.sourceName,
        name: c.sourceName,
        inferredType: c.inferredType,
        readOnly: readOnlyColumns,
        conflict: false
      }))
    })
  }
}

/** 去重：重复名自动追加 _n，并标记冲突（原名保持原样不自动改，仅复制时去重） */
function uniqueName(base: string, used: Set<string>): { name: string; conflict: boolean } {
  let candidate = base
  let n = 1
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_${n}`
    n++
  }
  return { name: candidate, conflict: candidate !== base }
}

function refreshConflicts(): void {
  const usedTables = new Set<string>()
  for (const t of edits) {
    const base = t.tableName.trim() || t.sourceName
    const r = uniqueName(base, usedTables)
    t.tableName = r.name
    t.conflict = r.conflict
    usedTables.add(r.name.toLowerCase())
    const usedCols = new Set<string>()
    for (const c of t.columns) {
      const colBase = c.name.trim() || c.sourceName
      const cr = uniqueName(colBase, usedCols)
      c.name = cr.name
      c.conflict = cr.conflict
      usedCols.add(cr.name.toLowerCase())
    }
  }
}

watch(edits, () => refreshConflicts(), { deep: true })

const conflictCount = computed(() => {
  const tables = edits.filter((t) => t.conflict).length
  const cols = edits.reduce((acc, t) => acc + t.columns.filter((c) => c.conflict).length, 0)
  return { tables, cols }
})

const totalTables = computed(() => edits.length)

function confirm(): void {
  refreshConflicts()
  const files: AnalyzeImportPayload['files'] = edits.map((t) => ({
    filePath: t.filePath,
    tableIndex: t.tableIndex,
    tableName: t.tableName.trim() || t.sourceName,
    columns: t.columns.map((c) => ({ index: c.index, name: c.name.trim() || c.sourceName }))
  }))
  props.onConfirm(files)
}

const typeColor: Record<string, string> = {
  integer: 'bg-[var(--c-primary-soft)] text-[var(--c-accent)]',
  real: 'bg-[var(--c-success-soft)] text-[var(--c-success)]',
  boolean: 'bg-[var(--c-warn-soft)] text-[var(--c-warn)]',
  text: 'bg-[var(--c-bg)] text-[var(--c-text-2)]'
}
</script>

<template>
  <div class="max-h-[72vh] w-full max-w-[90vw] overflow-auto text-sm">
    <p class="mb-3 text-xs text-[var(--c-text-2)]">
      为每个表确认表名与列名（原名 → 新名）。重名自动追加序号并高亮，确认后一次写入会话数据库，可在 SQL 中跨表查询。
    </p>

    <!-- 探测失败的文件 -->
    <div v-for="f in props.files" :key="f.filePath">
      <div v-if="f.errors.length > 0" class="mb-2 rounded border border-[var(--c-danger)] bg-[var(--c-danger-soft)] p-2 text-xs text-[var(--c-danger)]">
        <div class="font-semibold">{{ f.fileName }}</div>
        <div v-for="(e, i) in f.errors" :key="i" class="mt-0.5">{{ e }}</div>
      </div>
    </div>

    <!-- 每个文件 -->
    <div v-for="(f, fi) in props.files" :key="f.filePath" class="mb-4 rounded border border-[var(--c-border)]">
      <div v-if="f.errors.length === 0" class="border-b border-[var(--c-border)] bg-[var(--c-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--c-text)]">
        {{ fi + 1 }}. {{ f.fileName }} · {{ f.tables.length }} 张表
      </div>
      <div v-if="f.errors.length === 0" class="p-3">
        <div v-for="t in edits.filter((e) => e.fileIndex === fi)" :key="t.tableIndex" class="mb-3 last:mb-0">
          <!-- 表名 -->
          <div class="mb-1.5 flex items-center gap-2">
            <span class="w-16 shrink-0 text-xs text-[var(--c-text-2)]">表名</span>
            <span class="rounded bg-[var(--c-bg)] px-2 py-0.5 text-xs text-[var(--c-text-2)] line-through decoration-[var(--c-border-strong)]">{{ t.sourceName }}</span>
            <span class="text-xs text-[var(--c-border-strong)]">→</span>
            <input
              v-model="t.tableName"
              type="text"
              class="w-56 rounded border bg-[var(--c-surface)] px-2 py-1 text-xs outline-none focus:border-sky-500"
              :class="t.conflict ? 'border-[var(--c-danger)]' : 'border-[var(--c-border-strong)]'"
            />
            <span v-if="t.conflict" class="text-xs text-[var(--c-danger)]" title="与已有表重名，已自动加序号">⚠ 重名</span>
            <span class="text-xs text-[var(--c-text-2)]">
              <template v-if="t.rowCount !== null">{{ t.rowCount }} 行 · </template>{{ t.columns.length }} 列
            </span>
            <span v-if="t.readOnlyColumns" class="ml-auto rounded bg-[var(--c-bg)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-2)]">列名只读</span>
          </div>

          <!-- 列名 -->
          <div class="ml-8 overflow-hidden rounded border border-[var(--c-border)]">
            <table class="w-full table-fixed border-collapse text-xs">
              <thead>
                <tr class="bg-[var(--c-bg)] text-left text-[var(--c-text-2)]">
                  <th class="w-9 border border-[var(--c-border)] px-1 py-1">#</th>
                  <th class="w-[30%] border border-[var(--c-border)] px-2 py-1">原名</th>
                  <th class="border border-[var(--c-border)] px-2 py-1">新列名</th>
                  <th class="w-[18%] border border-[var(--c-border)] px-2 py-1">类型</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in t.columns" :key="c.index" class="odd:bg-[var(--c-bg)]">
                  <td class="border border-[var(--c-border)] px-1 py-1 text-center text-[var(--c-border-strong)]">{{ c.index + 1 }}</td>
                  <td class="truncate border border-[var(--c-border)] px-2 py-1 text-[var(--c-text-2)]" :title="c.sourceName">
                    <span class="line-through decoration-[var(--c-border-strong)]">{{ c.sourceName }}</span>
                  </td>
                  <td class="border border-[var(--c-border)] px-2 py-1">
                    <input
                      v-model="c.name"
                      type="text"
                      :disabled="c.readOnly"
                      class="w-full min-w-0 rounded border bg-[var(--c-surface)] px-2 py-0.5 text-xs outline-none focus:border-sky-500 disabled:bg-[var(--c-bg)] disabled:text-[var(--c-text-3)]"
                      :class="c.conflict ? 'border-[var(--c-danger)]' : 'border-[var(--c-border-strong)]'"
                    />
                  </td>
                  <td class="border border-[var(--c-border)] px-2 py-1">
                    <span class="rounded px-1.5 py-0.5 text-[10px]" :class="typeColor[c.inferredType] ?? typeColor.text">
                      {{ c.inferredType }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部 -->
    <div class="flex items-center justify-between border-t border-[var(--c-border)] pt-3">
      <div class="text-xs text-[var(--c-text-2)]">
        共 {{ totalTables }} 张表
        <span v-if="conflictCount.tables > 0 || conflictCount.cols > 0" class="text-[var(--c-danger)]">
          · {{ conflictCount.tables }} 个表名、{{ conflictCount.cols }} 个列名已自动去重
        </span>
      </div>
      <div class="flex gap-2">
        <button class="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--c-surface-2)]" @click="props.onClose">
          取消
        </button>
        <button class="rounded bg-[var(--c-primary)] px-3 py-1.5 text-sm text-[var(--c-on-primary)] hover:bg-[var(--c-primary-hover)]" @click="confirm">
          确认导入
        </button>
      </div>
    </div>
  </div>
</template>
