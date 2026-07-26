import { Op, type Transaction } from 'sequelize';
import { GroundDrop } from '@/Data/Models/GroundDrop.js';

/**
 * Column values for a new world drop.
 *
 * Carries the item's full identity - metadata, serial, custom name - not
 * just its type, because a drop is the same object temporarily living on
 * the ground: picking it back up must restore exactly what was dropped.
 * Position plus routing bucket is what scopes proximity queries to the
 * right world instance.
 */
export interface CreateGroundDropFields {
  ItemTypeID: string;
  StackQuantity: number | null;
  WeightGrams: string;
  MetadataJson?: string | null;
  CustomName?: string | null;
  UniqueSerial?: string | null;
  BoundCharacterID?: string | null;
  DroppedByCharacterID?: string | null;
  ContainerInventoryID?: string | null;
  World: number;
  PositionX: string;
  PositionY: string;
  PositionZ: string;
  DroppedAt: Date;
}

/**
 * Ground-drop data access. Append-on-drop / delete-on-pickup; no
 * mid-life mutations of a row. The delete path uses the
 * `dropped_at` fingerprint inside a transaction (decision 7 B1 fix)
 * to make pickup race-safe.
 */
export class GroundDropRepository {
  /**
   * Insert a world drop. Transaction-aware because dropping is a
   * composite - the item leaves the inventory and the drop appears in one
   * unit, so it can never exist in both places or neither.
   */
  async Create(Fields: CreateGroundDropFields, T?: Transaction): Promise<GroundDrop> {
    return await GroundDrop.create(
      {
        ItemTypeID: Fields.ItemTypeID,
        StackQuantity: Fields.StackQuantity,
        WeightGrams: Fields.WeightGrams,
        MetadataJson: Fields.MetadataJson ?? null,
        CustomName: Fields.CustomName ?? null,
        UniqueSerial: Fields.UniqueSerial ?? null,
        BoundCharacterID: Fields.BoundCharacterID ?? null,
        DroppedByCharacterID: Fields.DroppedByCharacterID ?? null,
        ContainerInventoryID: Fields.ContainerInventoryID ?? null,
        World: Fields.World,
        PositionX: Fields.PositionX,
        PositionY: Fields.PositionY,
        PositionZ: Fields.PositionZ,
        DroppedAt: Fields.DroppedAt,
      },
      T !== undefined ? { transaction: T } : undefined,
    );
  }

  /**
   * Race-safe delete: the affected-rows count tells the caller
   * whether they won the pickup race. Returns 1 on success, 0 when
   * another picker beat them (the row had already been deleted) or
   * when the row never existed.
   */
  async DeleteWithFingerprint(
    ID: string,
    DroppedAt: Date,
    T?: Transaction,
  ): Promise<number> {
    return await GroundDrop.destroy({
      where: { ID, DroppedAt },
      ...(T !== undefined ? { transaction: T } : {}),
    });
  }

  /**
   * Drop by id, for pickup. Returning a row is not authorisation - the
   * service still re-checks range and routing bucket, so a client cannot
   * name a distant drop and have it teleport over.
   */
  FindByID(ID: string): Promise<GroundDrop | null> {
    return GroundDrop.findByPk(ID);
  }

  /**
   * Drop by serial. Paired with the inventory-side lookup by
   * IdentifierService when minting, so one serial can never exist both on
   * the ground and in an inventory at once.
   */
  FindByUniqueSerial(Serial: string): Promise<GroundDrop | null> {
    return GroundDrop.findOne({ where: { UniqueSerial: Serial } });
  }

  /**
   * Every drop of one ItemTypeID dropped before `Before` - the
   * evidence age-sweep surface (blood splats and future decaying
   * types). Oldest first so a partial sweep clears the stalest rows.
   */
  FindByTypeOlderThan(ItemTypeID: string, Before: Date): Promise<GroundDrop[]> {
    return GroundDrop.findAll({
      where: { ItemTypeID, DroppedAt: { [Op.lt]: Before } },
      order: [['DroppedAt', 'ASC']],
    });
  }

  /**
   * Spatial filter: every drop within `RadiusMeters` of (`X`, `Y`,
   * `Z`) in the given routing bucket. Squared-distance compare in
   * memory (the bounding-box pre-filter on (position_x, position_y)
   * cuts the row count enough that the JS pass is cheap).
   */
  async FindInRadius(
    World: number,
    X: number,
    Y: number,
    Z: number,
    RadiusMeters: number,
  ): Promise<GroundDrop[]> {
    const Box = RadiusMeters + 1;
    const Rows = await GroundDrop.findAll({
      where: {
        World,
        PositionX: { [Op.between]: [(X - Box).toFixed(3), (X + Box).toFixed(3)] },
        PositionY: { [Op.between]: [(Y - Box).toFixed(3), (Y + Box).toFixed(3)] },
      },
      order: [['DroppedAt', 'DESC']],
    });
    const RadiusSq = RadiusMeters * RadiusMeters;
    return Rows.filter((Row) => {
      const Dx = Number.parseFloat(Row.PositionX) - X;
      const Dy = Number.parseFloat(Row.PositionY) - Y;
      const Dz = Number.parseFloat(Row.PositionZ) - Z;
      return Dx * Dx + Dy * Dy + Dz * Dz <= RadiusSq;
    });
  }

  /** Delete every drop within the radius. Returns the deleted count. */
  async DeleteInRadius(
    World: number,
    X: number,
    Y: number,
    Z: number,
    RadiusMeters: number,
  ): Promise<GroundDrop[]> {
    const Rows = await this.FindInRadius(World, X, Y, Z, RadiusMeters);
    if (Rows.length === 0) return Rows;
    await GroundDrop.destroy({ where: { ID: Rows.map((R) => R.ID) } });
    return Rows;
  }

  /** Every drop in the routing bucket - used at server boot to re-spawn props. */
  ListInWorld(World: number): Promise<GroundDrop[]> {
    return GroundDrop.findAll({ where: { World } });
  }
}
