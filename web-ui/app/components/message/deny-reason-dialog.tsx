// components/message/deny-reason-dialog.tsx — 工具审批"拒绝理由"弹窗(域4-2,交互审查 3E)。
//
// 替换 workspace-tool-part 原来的 window.prompt:WebView2 原生 prompt 标题栏硬编码
// "localhost:8080 显示"、样式与应用割裂,且只返回单行 string。改用应用内 Dialog +
// Textarea,与重命名弹窗等观感一致。理由可空——空提交=不带理由拒绝(语义同旧 prompt
// 直接点确定);Esc/取消=放弃本次拒绝(语义同旧 prompt 点取消),不触发 onConfirm。
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";

interface DenyReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 确认拒绝;reason 为用户填写(可能为空字符串,与旧 prompt 空串语义一致)。 */
  onConfirm: (reason: string) => void;
}

export function DenyReasonDialog({ open, onOpenChange, onConfirm }: DenyReasonDialogProps) {
  const { t } = useTranslation("message");
  const [reason, setReason] = React.useState("");

  // 每次打开清空上次输入(同一 Dialog 实例复用于多次拒绝)
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const handleConfirm = () => {
    onConfirm(reason);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tool_part.deny_dialog_title")}</DialogTitle>
          <DialogDescription>{t("tool_part.deny_dialog_desc")}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("tool_part.deny_dialog_placeholder")}
          className="min-h-24"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("tool_part.deny_dialog_cancel")}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {t("tool_part.deny_dialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
