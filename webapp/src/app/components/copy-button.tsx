import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button, type ButtonProps } from '@/components/ui/button';

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 回退 */
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, value.length);
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(helper);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label,
  size = 'sm',
  variant = 'outline',
  className
}: {
  value: string;
  label?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error('复制失败，请手动选中后复制');
    }
  };

  return (
    <Button type="button" size={size} variant={variant} onClick={() => void handleCopy()} className={cn(className)}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? '已复制' : (label ?? '复制')}
    </Button>
  );
}
