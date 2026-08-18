import { useContext, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AuthContext } from '../App';
import { ImagesAdminContent } from './ImagesAdmin';
import { CustomImagesContent } from './CustomImages';
import { consoleAdminPageClass, consoleButtonFocusClass } from '../lib/consoleTokens';
import { cn } from '../lib/utils';

const TAB_CUSTOM = 'custom';
const TAB_AGENT = 'agent';

const TAB_LABELS = {
  [TAB_CUSTOM]: 'Custom Images',
  [TAB_AGENT]: 'Agent Images',
};

export default function ImagesManager() {
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAgentPath = location.pathname === '/admin/images';
  const rawTab = searchParams.get('tab');
  const activeTab = isAdmin && (isAgentPath || rawTab === TAB_AGENT) ? TAB_AGENT : TAB_CUSTOM;

  useEffect(() => {
    if (rawTab === TAB_AGENT && !isAdmin) {
      setSearchParams({}, { replace: true });
    }
  }, [rawTab, isAdmin, setSearchParams]);

  function switchTab(tab) {
    if (tab === TAB_AGENT) {
      navigate('/custom-images?tab=agent', { replace: true });
    } else {
      navigate('/custom-images', { replace: true });
    }
  }

  const tabs = isAdmin
    ? [TAB_CUSTOM, TAB_AGENT]
    : [TAB_CUSTOM];

  return (
    <div className={consoleAdminPageClass}>
      {tabs.length > 1 && (
        <div className="mb-5 flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 w-fit">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => switchTab(tab)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                consoleButtonFocusClass,
                activeTab === tab
                  ? 'bg-white text-zinc-900 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-900',
              )}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      )}

      {activeTab === TAB_AGENT
        ? <div className="flex min-h-0 flex-1 flex-col"><ImagesAdminContent /></div>
        : <CustomImagesContent />}
    </div>
  );
}
