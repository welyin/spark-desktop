import { app } from 'electron';
import { UpdaterService } from './service';

let updaterService: UpdaterService | null = null;

export function initUpdaterService(): UpdaterService {
  if (updaterService) {
    return updaterService;
  }

  updaterService = new UpdaterService(app.getPath('userData'), app.getVersion());
  return updaterService;
}

export function getUpdaterService(): UpdaterService {
  if (!updaterService) {
    throw new Error('Updater service is not initialized');
  }
  return updaterService;
}
