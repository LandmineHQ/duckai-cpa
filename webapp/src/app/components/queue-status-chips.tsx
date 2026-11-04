import { Activity, Clock3, Gauge, Timer } from 'lucide-react';
import { useOverview } from '@/app/lib/overview-context';
import { formatDuration } from '@/app/lib/format';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 页头/侧栏共用的队列状态徽章：inFlight / waiting / rps / avgWaitMs。 */
export function QueueStatusChips({ className = '' }: { className?: string }) {
  const { data } = useOverview();
  const queue = data?.upstream?.queue;
  const waiting = queue?.waiting ?? 0;
  const inFlight = queue?.inFlight ?? 0;
  const rps = queue?.rps ?? 1;
  const avgWaitMs = queue?.avgWaitMs ?? 0;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={inFlight > 0 ? 'warning' : 'muted'} className="gap-1">
            <Activity className="h-3 w-3" />
            执行中 {inFlight}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>当前正在执行的上游请求数（maxConcurrent: {queue?.maxConcurrent ?? 1}）</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={waiting > 0 ? 'warning' : 'muted'} className="gap-1">
            <Clock3 className="h-3 w-3" />
            排队 {waiting}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>FIFO 队列中等待的上游请求数（上限 {queue?.limit ?? 50}）</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1">
            <Gauge className="h-3 w-3" />
            RPS {rps}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>每秒最多开始的上游请求数（配置：upstream.rps）</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1">
            <Timer className="h-3 w-3" />
            均等 {formatDuration(avgWaitMs)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>最近上游请求的平均排队等待时间</TooltipContent>
      </Tooltip>
    </div>
  );
}
