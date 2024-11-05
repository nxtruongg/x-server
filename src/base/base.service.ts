import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model } from 'mongoose';
import { CacheService } from 'src/cache/cache.service';
import { ActivityLogService } from 'src/modules/systems/activityLog/activityLog.service';
import { IUser } from './base.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class BaseService<T> {
  @Inject(CacheService)
  private readonly cacheService: CacheService;

  @Inject(ActivityLogService)
  private readonly activityLogService: ActivityLogService;

  private readonly eventEmitter: EventEmitter2;

  constructor(@InjectModel('') private readonly model: Model<T>) {
    if (!model) {
      throw new InternalServerErrorException(
        'Model not injected properly in BaseService',
      );
    }
  }

  protected async beforeCreate(
    data: Partial<T>,
    user: IUser,
  ): Promise<Partial<T>> {
    return data;
  }

  protected async afterCreate(entity: T, user: IUser): Promise<void> {}

  protected async beforeUpdate(
    id: string,
    data: Partial<T>,
    user: IUser,
  ): Promise<Partial<T>> {
    return data;
  }

  protected async afterUpdate(entity: T, user: IUser): Promise<void> {}

  protected async beforeRemove(entity: T, user: IUser): Promise<void> {}

  protected async afterRemove(entity: T, user: IUser): Promise<void> {}

  protected async onView(data: T[], user: IUser): Promise<T[]> {
    return data;
  }
  protected async onFinding(
    condition: FilterQuery<T> = {},
    user: IUser,
  ): Promise<FilterQuery<T>> {
    return condition;
  }

  async create(data: Partial<T>, user: IUser): Promise<T> {
    try {
      if (user?.userId) {
        data['createdBy'] = user.userId;
      }

      const processedData = await this.beforeCreate(data, user);
      const entity = new this.model(processedData);
      await entity.save();

      await this.afterCreate(entity, user);
      await this.logActivity('create', entity._id.toString(), user, data);
      await this.cacheService.delCache(
        `${this.model.collection.name}-findAll-*`,
      );
      this.eventEmitter.emit(`${this.model.modelName}.saved`, {
        entity,
        user,
      });
      return entity;
    } catch (error) {
      throw new InternalServerErrorException('Error creating entity');
    }
  }

  async update(id: string, data: Partial<T>, user: IUser): Promise<T> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid ID format');
    }

    try {
      if (user?.userId) {
        data['updatedBy'] = user.userId;
      }

      const processedData = await this.beforeUpdate(id, data, user);
      const entity = await this.model
        .findByIdAndUpdate(id, processedData, { new: true })
        .exec();

      if (!entity) {
        throw new NotFoundException(`Entity with id ${id} not found`);
      }

      await this.afterUpdate(entity, user);
      await this.logActivity('update', id, user, data);
      await this.cacheService.delCache(
        `${this.model.collection.name}-findOne-${id}`,
      );
      await this.cacheService.delCache(
        `${this.model.collection.name}-findAll-*`,
      );
      this.eventEmitter.emit(`${this.model.modelName}.saved`, {
        entity,
        user,
      });
      return entity;
    } catch (error) {
      throw new InternalServerErrorException('Error updating entity');
    }
  }

  async remove(id: string, user: IUser): Promise<void> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid ID format');
    }

    try {
      const entity = await this.model.findById(id).exec();
      await this.beforeRemove(entity, user);

      const result = await this.model.findByIdAndDelete(id).exec();
      if (!result) {
        throw new NotFoundException(`Entity with id ${id} not found`);
      }

      await this.afterRemove(entity, user);
      await this.logActivity('delete', id, user, entity);
      await this.cacheService.delCache(
        `${this.model.collection.name}-findOne-${id}`,
      );
      await this.cacheService.delCache(
        `${this.model.collection.name}-findAll-*`,
      );
      this.eventEmitter.emit(`${this.model.modelName}.deleted`, {
        entity,
        user,
      });
    } catch (error) {
      throw new InternalServerErrorException('Error removing entity');
    }
  }

  async findAll(
    filter: FilterQuery<T> = {},
    page: number = 1,
    limit: number = 10,
    sort: Record<string, 1 | -1> = {},
    user: IUser,
  ): Promise<{ data: T[]; total: number; page: number; limit: number }> {
    const condition = await this.onFinding(filter, user);
    const cacheKey = `${this.model.collection.name}-findAll-${JSON.stringify(condition)}-${page}-${limit}-${JSON.stringify(sort)}`;
    const cachedResult = await this.cacheService.getCached(cacheKey);
    if (cachedResult) return cachedResult as any;

    const skip = (page - 1) * limit;

    try {
      const total = await this.model.countDocuments(condition).exec();
      const data = await this.model
        .find(condition)
        .skip(skip)
        .limit(limit)
        .sort(sort)
        .exec();
      const processedData = await this.onView(data, user);
      const result = { data: processedData as any, total, page, limit };
      await this.cacheService.setCached(cacheKey, result);
      await this.logActivity('viewAll', '', user, condition);

      return result;
    } catch (error) {
      throw new InternalServerErrorException('Error fetching entities');
    }
  }

  async findOne(id: string, user: IUser): Promise<T> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid ID format');
    }
    const cacheKey = `${this.model.collection.name}-findOne-${id}`;
    const cachedEntity = await this.cacheService.getCached<T>(cacheKey);

    if (cachedEntity) {
      return cachedEntity;
    }

    try {
      const entity = await this.model.findById(id).exec();
      if (!entity) {
        throw new NotFoundException(`Entity with id ${id} not found`);
      }
      await this.cacheService.setCached(cacheKey, entity);
      await this.logActivity('view', id, user);
      const data = this.onView([entity], user);
      return data[0] ? data[0] : data;
    } catch (error) {
      throw new InternalServerErrorException('Error fetching entity');
    }
  }

  async search(
    query: string,
    page: number = 1,
    limit: number = 10,
    user: IUser,
  ): Promise<{ data: T[]; total: number; page: number; limit: number }> {
    try {
      const filter = { $text: { $search: query } };
      const result = await this.findAll(filter, page, limit, {}, user);

      await this.logActivity('search', '', user, { query } as any);
      return result;
    } catch (error) {
      throw new InternalServerErrorException('Error searching entities');
    }
  }

  protected async logActivity(
    action: string,
    documentId: string,
    user: IUser,
    changes?: Partial<T>,
  ): Promise<void> {
    try {
      await this.activityLogService.logActivity(
        action,
        documentId,
        this.model.collection.name,
        user,
        changes,
      );
    } catch (error) {
      console.error('Create log system error', error);
    }
  }

  async softRemove(id: string, user?: IUser): Promise<void> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid ID format');
    }

    try {
      const entity = await this.model
        .findByIdAndUpdate(
          id,
          { isDeleted: true, deletedBy: user?.userId, deletedAt: new Date() },
          { new: true },
        )
        .exec();

      if (!entity) {
        throw new NotFoundException(`Entity with id ${id} not found`);
      }

      await this.logActivity('softDelete', id, user);
    } catch (error) {
      throw new InternalServerErrorException('Error soft-deleting entity');
    }
  }
}