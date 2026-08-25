import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import { CustomImagesContent } from './CustomImages';
import { consoleAdminPageClass } from '../lib/consoleTokens';

export default function ImagesManager() {
  const { t } = useTranslation();
  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title={t('images:title')} />
      <CustomImagesContent />
    </div>
  );
}
