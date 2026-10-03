'use client';

import { useState, useRef, useEffect } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '@/lib/notifications-store';
import { formatRelativeTime } from '@/lib/activity-store';

export function NotificationBell() {
  const { notifications, markAllRead, unreadCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleToggle = () => {
    setOpen((v) => !v);
    if (!open && unreadCount > 0) markAllRead();
  };

  return (
    <div className="notif-bell-wrap" ref={ref}>
      <button className="notif-bell-btn" onClick={handleToggle} aria-label="Notifications">
        <Bell size={16} color="var(--ink)" />
        {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
      </button>
      {open && (
        <div className="notif-dropdown">
          <div className="notif-dropdown-head">
            <h5>Notifications</h5>
          </div>
          {notifications.length === 0 ? (
            <div className="notif-empty">You&apos;re all caught up.</div>
          ) : (
            notifications.map((n) => (
              <div className={`notif-item ${n.read ? '' : 'unread'}`} key={n.id}>
                <div className="t">{n.title}</div>
                <div className="b">{n.body}</div>
                <span className="ts">{formatRelativeTime(n.timestamp)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
