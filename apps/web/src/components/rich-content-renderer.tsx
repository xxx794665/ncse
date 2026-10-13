/**
 * RichContentRenderer 富片段渲染（docs/design/设计规范.md §3.3/§7.1/§7.3，T1-08e）
 * 渲染 packages/shared 的 RichContent（文本段 + 图片段有序混合），
 * 供题干（stem）/ 选项（option）/ 解析（analysis）/ 材料（material）四处共用（T1-08f/g 接线消费）。
 * - 文本段 = 段落级 <p>（导入管线语义即段级、段边缘已修剪）；空/全空白段跳过
 * - 图片段 = §7.3 图片插槽：块级居中 figure、懒加载、4:3 骨架占位（§6.8 呼吸）、
 *   失败可读占位（含 alt），点击进入全屏 lightbox（Esc / 遮罩点击关闭）
 * 图片段 path 已由 API 投影为可渲染绝对 URL（GET /api/img/<键>），组件零 URL 拼装逻辑。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageOff, X } from 'lucide-react'
import type { RichContent, RichSegment } from '@ncse/shared'
import './rich-content-renderer.css'

/**
 * 排版变体（§3.3 阅读三级 + §3.2 解析正文）。
 * 四变体字号/字重/行高差异明显，故设为必填 prop：强制接线方显式选择，
 * 避免缺省值被遗漏时静默用错排版层级。
 */
export type RichContentVariant = 'stem' | 'option' | 'analysis' | 'material'

export interface RichContentRendererProps {
  /** 富片段内容（空数组或全部段被跳过时不渲染任何节点） */
  content: RichContent
  /** 排版变体（必填，理由见 RichContentVariant 注释） */
  variant: RichContentVariant
}

type ImageSegment = Extract<RichSegment, { type: 'image' }>

/** 图片段加载状态机：loading（骨架占位）→ loaded / error（可读失败占位） */
type RichImageStatus = 'loading' | 'loaded' | 'error'

interface RichImageLightboxProps {
  src: string
  /** 已规范化的 alt（缺省为空串 = 装饰图语义） */
  alt: string
  onClose: () => void
}

/**
 * 图片全屏查看 lightbox：遮罩（--z-overlay + --color-bg-overlay，层级参照 modal.css）
 * + 图片 contain 居中；Esc / 点击遮罩 / 关闭按钮关闭；开启时锁定 body 滚动。
 * 简版取舍：不含捏合/按钮缩放（记为遗留，见任务报告）。
 */
function RichImageLightbox({ src, alt, onClose }: RichImageLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // 打开时初始聚焦对话框（基本可用的焦点管理）；Esc 关闭
  useEffect(() => {
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // body 滚动锁定（与 Modal 一致的做法）
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return createPortal(
    <div
      ref={dialogRef}
      className="ncse-rich-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `查看图片：${alt}` : '查看图片'}
      tabIndex={-1}
      onClick={onClose}
    >
      <div className="ncse-rich-lightbox__toolbar" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="ncse-rich-lightbox__btn"
          onClick={onClose}
          aria-label="关闭"
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ncse-rich-lightbox__stage">
        <img
          className="ncse-rich-lightbox__image"
          src={src}
          alt={alt}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  )
}

/** 单个图片段（§7.3 图片插槽）：骨架占位 + 懒加载 + 失败占位 + lightbox 全屏查看 */
function RichImageBlock({ segment }: { segment: ImageSegment }) {
  const [status, setStatus] = useState<RichImageStatus>('loading')
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  // 缺 alt 为空串 = 装饰图语义
  const alt = segment.alt ?? ''

  const closeLightbox = () => {
    setLightboxOpen(false)
    // 关闭后焦点归还触发按钮
    openButtonRef.current?.focus()
  }

  return (
    <figure className={`ncse-rich-content__figure${status === 'loading' ? ' is-loading' : ''}`}>
      {status === 'error' ? (
        <div className="ncse-rich-content__image-error">
          <ImageOff aria-hidden="true" />
          <span className="ncse-rich-content__image-error-text">图片加载失败</span>
          {alt && <span className="ncse-rich-content__image-error-alt">{alt}</span>}
        </div>
      ) : (
        <>
          {status === 'loading' && (
            <div className="ncse-rich-content__skeleton" aria-hidden="true" />
          )}
          <button
            ref={openButtonRef}
            type="button"
            className="ncse-rich-content__image-btn"
            onClick={() => setLightboxOpen(true)}
            aria-label={alt ? `查看大图：${alt}` : '查看大图'}
            // 加载中按钮视觉隐藏（骨架之上），同时移出 Tab 序避免聚焦不可见元素
            tabIndex={status === 'loading' ? -1 : undefined}
          >
            <img
              className="ncse-rich-content__image"
              src={segment.path}
              alt={alt}
              loading="lazy"
              decoding="async"
              onLoad={() => setStatus('loaded')}
              onError={() => setStatus('error')}
            />
          </button>
        </>
      )}
      {lightboxOpen && <RichImageLightbox src={segment.path} alt={alt} onClose={closeLightbox} />}
    </figure>
  )
}

export function RichContentRenderer({ content, variant }: RichContentRendererProps) {
  // 空/全空白文本段跳过（不渲染空 <p>）；图片段始终保留
  const segments = content.filter(
    (segment) => segment.type === 'image' || segment.text.trim().length > 0,
  )
  if (segments.length === 0) return null

  return (
    <div className={`ncse-rich-content ncse-rich-content--${variant}`}>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          // 段序列静态、不发生重排，index 作 key 安全
          <p key={index} className="ncse-rich-content__text">
            {segment.text}
          </p>
        ) : (
          <RichImageBlock key={index} segment={segment} />
        ),
      )}
    </div>
  )
}
