import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // issue8:轨道高度必须是整数像素(h-4.5=18px;原 1.15rem=18.4px)。非整数高度让
        // 圆角边缘落在半像素上(任何倍率都有锯齿),且拇指(16px)垂直居中余量 2.4px 无法
        // 均分,在 125%/150% 等非整数 DPI 下轨道与拇指各自取整方向不同 → 可见错位。
        // 问题7(2.0.0 内测):关闭态轨道弃用 --input(两主题都是 8% 透明度,叠在卡片上
        // 近乎隐形,悬停态反而更深) → muted-foreground 阶梯:静止 /25、悬停 /35,
        // 随主题自适应且始终弱于选中态 primary。
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/25 focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-muted-foreground/30 group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all duration-200 outline-none [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-4.5 data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 hover:data-[state=unchecked]:bg-muted-foreground/35",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // issue8:去掉选中态 scale-110——16px×1.1=17.6px 非整数,拇指圆边在所有 DPI
          // 下都会锯齿。弹跳手感由 translate 的 cubic-bezier 过冲保留。
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block rounded-full ring-0 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
