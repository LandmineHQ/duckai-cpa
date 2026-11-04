import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/**
 * 全局 toast 容器（sonner）。主题由 App 传入，跟随当前 light/dark 解析结果。
 */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="top-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: 'border border-border bg-card text-card-foreground shadow-lg',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground'
        }
      }}
      {...props}
    />
  );
}
