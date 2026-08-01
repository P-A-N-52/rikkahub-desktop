import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "~/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip"

// 前端重构R4:通用按钮换 NewMax DsButton 交互语言——胶囊圆角、transition-all、
// 按压 opacity-70(替代 scale 缩放)、实底钮 hover opacity-80、ghost hover 走
// on-surface 底色。花色主题下由 ds 令牌派生自动跟随。
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-150 active:opacity-70 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:opacity-80",
        destructive:
          "bg-destructive text-white shadow-sm hover:opacity-80 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-[var(--ds-on-surface)] hover:border-ring/50 dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-[var(--ds-on-surface)] text-secondary-foreground hover:bg-[var(--ds-on-surface-active)]",
        ghost:
          "hover:bg-[var(--ds-on-surface)] hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline active:opacity-100",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  title,
  disabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  const element = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled}
      title={disabled ? title : undefined}
      {...props}
    />
  )

  // G7:title 统一升级为 DS Tooltip(替代 Windows 原生黄条,对齐 NewMax)。
  // disabled 按钮收不到 hover 事件,保留原生 title 兜底。
  // 注意:被 XxxTrigger asChild 包裹的 Button 不能带 title(Slot 属性会合并到
  //   Tooltip 根组件上而丢失)——此类调用点一律只留 aria-label。
  if (!title || disabled) return element

  return (
    <Tooltip>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}

export { Button, buttonVariants }
