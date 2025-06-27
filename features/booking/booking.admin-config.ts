import { createAdminEntity } from '@/lib/admin-generator';
import { BookingSchema } from './booking.schema';
import { bookingService } from './booking.service';

const notImplemented = () => Promise.reject(new Error('Not implemented'));

export const BookingAdminConfig = createAdminEntity('Réservations', BookingSchema, {
  description: 'Gérez vos réservations',
  icon: '📖',
  actions: { create: false, read: true, update: false, delete: false, bulk: false, export: false },
  services: {
    fetchItems: bookingService.fetchItems,
    createItem: notImplemented,
    updateItem: notImplemented,
    deleteItem: notImplemented,
  },
  queryKey: ['bookings'],
});
